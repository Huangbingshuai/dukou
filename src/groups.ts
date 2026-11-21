import type { Conversation, Origin, Message } from './ir.ts';
import { canonicalize } from './ir.ts';
import { Ledger, type MirrorRecord, type ReplicaRef } from './ledger.ts';
import { mirrorConversation, type MirrorOptions } from './mirror.ts';
import { withGroupLock } from './lock.ts';
import { missingMessages } from './ids.ts';
import { ClaudeReader } from './adapters/claude.ts';
import { CodexReader } from './adapters/codex.ts';
import { DshReader } from './adapters/dsh.ts';

/**
 * One realtime pass over every known mirror group.
 *
 * All three logs are append-only, so the replica holding the most messages is the
 * most advanced one. It leads, and the others are brought up to it through the
 * ordinary mirror path (fingerprint diff + append). Groups only exist after an
 * explicit migrate, so a periodic pass never invents conversations by itself.
 */

export interface GroupSyncResult {
  groupId: string;
  title: string;
  leader: { origin: Origin; sessionId: string; messages: number } | null;
  changed: Array<{ origin: Origin; action: string; missing: number; sessionId?: string }>;
  error?: string;
}

function readerFor(origin: Origin) {
  if (origin === 'codex') return new CodexReader();
  if (origin === 'claude') return new ClaudeReader();
  return new DshReader();
}

function applyHomes(options: MirrorOptions): () => void {
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    DSH_HOME: process.env.DSH_HOME,
  };
  if (options.codex) process.env.CODEX_HOME = options.codex;
  if (options.claude) process.env.CLAUDE_HOME = options.claude;
  if (options.dsh) process.env.DSH_HOME = options.dsh;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function syncGroups(options: MirrorOptions = {}): Promise<GroupSyncResult[]> {
  const restore = applyHomes(options);
  try {
    const ledger = new Ledger(options.ledgerPath);
    const results: GroupSyncResult[] = [];
    for (const record of ledger.all()) {
      if (options.groupId && record.groupId !== options.groupId) continue;
      // One writer per group: the page button and this pass may land together,
      // and two appends of the same delta would duplicate the conversation.
      try {
        results.push(await withGroupLock(record.groupId, () => converge(record, options), { timeoutMs: 8000 }));
      } catch (error) {
        results.push({
          groupId: record.groupId,
          title: record.title,
          leader: null,
          changed: [],
          error: (error as Error).message,
        });
      }
    }
    return results;
  } finally {
    restore();
  }
}

/**
 * Brings a group into agreement in every direction.
 *
 * The big replica goes first (one pass copies everything it has to the others).
 * Then every other replica is checked for messages the leader does not have —
 * that happens when both tools were actually in use, or when they were typed in
 * side by side — and pushed back. Fingerprints make the reverse pass append only
 * genuinely new messages, never copies of what is already there.
 */
async function converge(record: MirrorRecord, options: MirrorOptions): Promise<GroupSyncResult> {
  const replicas = Object.entries(record.replicas) as Array<[Origin, ReplicaRef]>;
  let leader: GroupSyncResult['leader'] = null;
  for (const [origin, ref] of replicas) {
    if (!ref?.sessionId) continue;
    try {
      const conversation = await readerFor(origin).read(ref.sessionId);
      const count = canonicalize(conversation.messages).length;
      if (!leader || count > leader.messages) leader = { origin, sessionId: ref.sessionId, messages: count };
    } catch {
      continue;
    }
  }
  if (!leader) return { groupId: record.groupId, title: record.title, leader: null, changed: [], error: 'no readable replica' };

  const changed: GroupSyncResult['changed'] = [];
  const collect = (targets: Awaited<ReturnType<typeof mirrorConversation>>['targets']) => {
    for (const plan of targets) {
      if (plan.action === 'skip' && !plan.error) continue;
      changed.push({
        origin: plan.origin,
        action: plan.error ? 'error' : plan.action,
        missing: plan.missing,
        sessionId: plan.sessionId,
      });
    }
  };

  const leaderOrigin = leader.origin;
  const leaderTargets = (Object.keys(record.replicas) as Origin[]).filter((origin) => origin !== leaderOrigin);
  const forward = await mirrorConversation(leaderOrigin, leader.sessionId, leaderTargets, {
    ...options,
    locked: true,
  });
  collect(forward.targets);

  // Anything the other replicas gained while the leader was away goes back.
  for (const other of leaderTargets) {
    const ref = record.replicas[other];
    if (!ref?.sessionId) continue;
    try {
      const otherConversation = await readerFor(other).read(ref.sessionId);
      const otherMessages = canonicalize(otherConversation.messages);
      const leaderConversation = await readerFor(leaderOrigin).read(leader.sessionId);
      const leaderMessages = canonicalize(leaderConversation.messages);
      const leaderLacks = missingMessages(leaderMessages, otherMessages);
      if (leaderLacks.length === 0) continue;
      const reverse = await mirrorConversation(other, ref.sessionId, leaderTargets.filter((origin) => origin !== other), {
        ...options,
        locked: true,
      });
      collect(reverse.targets);
    } catch {
      continue;
    }
  }

  return { groupId: record.groupId, title: record.title, leader, changed };
}

/** Union of every replica's messages for display, without any write. */
export async function groupMessages(record: MirrorRecord): Promise<Message[]> {
  let best: Message[] = [];
  for (const [origin, ref] of Object.entries(record.replicas) as Array<[Origin, ReplicaRef]>) {
    if (!ref?.sessionId) continue;
    try {
      const conversation: Conversation = await readerFor(origin).read(ref.sessionId);
      const messages = canonicalize(conversation.messages);
      if (messages.length > best.length) best = messages;
    } catch {
      continue;
    }
  }
  return best;
}
