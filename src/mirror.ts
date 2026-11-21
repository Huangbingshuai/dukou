import type { Conversation, Origin, Reader } from './ir.ts';
import { canonicalize } from './ir.ts';
import { missingMessages, messageFingerprint } from './ids.ts';
import { withGroupLock } from './lock.ts';
import { Ledger, type MirrorRecord, type ReplicaRef } from './ledger.ts';
import { uuidV5 } from './ids.ts';
import { ClaudeReader } from './adapters/claude.ts';
import { CodexReader } from './adapters/codex.ts';
import { DshReader } from './adapters/dsh.ts';
import { appendClaude, writeClaude } from './writers/claude.ts';
import { appendCodex, writeCodex } from './writers/codex.ts';
import { appendDsh, writeDsh } from './writers/dsh.ts';

/**
 * The mirror engine.
 *
 * Every harness re-mints its own ids, so convergence is decided on content
 * fingerprints (see `ids.ts`), not on ids. A group is one conversation and its
 * one replica per harness; each run reads the source, diffs every replica and
 * appends only what is missing, which makes a second sync cheap and idempotent.
 */

export interface MirrorHomes {
  codex?: string;
  claude?: string;
  dsh?: string;
  /** Where pre-write database/registry backups go. */
  backupDir?: string;
}

export interface MirrorOptions extends MirrorHomes {
  ledgerPath?: string;
  dryRun?: boolean;
  /** caller already holds the group lock (the realtime pass does) */
  locked?: boolean;
  /** restrict a group pass to one group (the page's send button) */
  groupId?: string;
}

export interface TargetPlan {
  origin: Origin;
  action: 'create' | 'append' | 'skip';
  missing: number;
  unrepresentable?: number;
  sessionId?: string;
  path?: string;
  error?: string;
}

export interface MirrorResult {
  groupId: string;
  source: { origin: Origin; sessionId: string };
  title: string;
  canonicalMessages: number;
  targets: TargetPlan[];
}

function makeReader(origin: Origin): Reader {
  if (origin === 'codex') return new CodexReader();
  if (origin === 'claude') return new ClaudeReader();
  return new DshReader();
}

export function groupIdFor(origin: Origin, sessionId: string): string {
  return uuidV5(`mirror-group:${origin}:${sessionId}`);
}

function isMissingReplica(error: unknown, origin: Origin, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === `${origin} session not found: ${sessionId}`) return true;
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Applies home overrides to the readers, which resolve their roots from the environment. */
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

export async function mirrorConversation(
  sourceOrigin: Origin,
  sourceId: string,
  targets: Origin[],
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  if (options.locked) return mirrorConversationUnlocked(sourceOrigin, sourceId, targets, options);
  return withGroupLock(groupIdFor(sourceOrigin, sourceId), () =>
    mirrorConversationUnlocked(sourceOrigin, sourceId, targets, options),
  );
}

async function mirrorConversationUnlocked(
  sourceOrigin: Origin,
  sourceId: string,
  targets: Origin[],
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  const restore = applyHomes(options);
  try {
    return await runMirror(sourceOrigin, sourceId, targets, options);
  } finally {
    restore();
  }
}

async function runMirror(
  sourceOrigin: Origin,
  sourceId: string,
  targets: Origin[],
  options: MirrorOptions,
): Promise<MirrorResult> {
  const source = await makeReader(sourceOrigin).read(sourceId);
  const sourceMessages = canonicalize(source.messages);
  // An empty stub is a real thing in all three stores (a draft, an aborted start).
  // Copying it would create empty shells that look like broken imports, so refuse.
  if (sourceMessages.length === 0) {
    throw new Error(
      `会话 ${sourceOrigin}/${sourceId} 没有任何可迁移的消息（空会话），未做任何写入`,
    );
  }
  const ledger = new Ledger(options.ledgerPath);

  let record = ledger.findByReplica(sourceOrigin, sourceId);
  if (!record) {
    record = {
      groupId: groupIdFor(sourceOrigin, sourceId),
      title: source.title,
      cwd: source.cwd,
      projectName: source.projectName,
      replicas: { [sourceOrigin]: { sessionId: sourceId, path: source.path } } as MirrorRecord['replicas'],
      synced: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  record.title = source.title || record.title;
  record.cwd = source.cwd || record.cwd;
  record.projectName = source.projectName || record.projectName;

  const plans: TargetPlan[] = [];
  for (const target of targets) {
    if (target === sourceOrigin) {
      plans.push({ origin: target, action: 'skip', missing: 0 });
      continue;
    }
    // npm-style dynamic dispatch keeps the writer modules independent.
    const write = writeFor(target);
    const append = appendFor(target);
    const ref: ReplicaRef | undefined = record.replicas[target];
    const blocked = new Set(record.unrepresentable?.[target] ?? []);
    const representable = blocked.size
      ? sourceMessages.filter((message) => !blocked.has(messageFingerprint(message)))
      : sourceMessages;

    try {
      if (!ref) {
        if (options.dryRun) {
          plans.push({ origin: target, action: 'create', missing: representable.length });
          continue;
        }
        const result = write({ ...source, messages: representable }, options);
        record.replicas[target] = { sessionId: result.sessionId, path: result.path };
        // Record the replica before anything else can throw: a file on disk that
        // the ledger does not know about would be orphaned by the next attempt.
        ledger.upsert(record);
        if (!options.dryRun) ledger.save();
        const plan: TargetPlan = {
          origin: target,
          action: 'create',
          missing: representable.length,
          sessionId: result.sessionId,
          path: result.path,
        };
        await recordBlocked(target, record, plan, sourceMessages);
        plans.push(plan);
        continue;
      }

      let existing;
      try {
        existing = await makeReader(target).read(ref.sessionId);
      } catch (error) {
        if (!isMissingReplica(error, target, ref.sessionId)) throw error;
      }

      if (!existing) {
        if (options.dryRun) {
          plans.push({ origin: target, action: 'create', missing: representable.length });
          continue;
        }
        const result = write({ ...source, messages: representable }, options);
        record.replicas[target] = { sessionId: result.sessionId, path: result.path };
        ledger.upsert(record);
        ledger.save();
        const plan: TargetPlan = {
          origin: target,
          action: 'create',
          missing: representable.length,
          sessionId: result.sessionId,
          path: result.path,
        };
        await recordBlocked(target, record, plan, sourceMessages);
        plans.push(plan);
        continue;
      }

      const targetMessages = canonicalize(existing.messages);
      const missing = missingMessages(targetMessages, representable);
      if (missing.length === 0) {
        plans.push({ origin: target, action: 'skip', missing: 0, sessionId: ref.sessionId });
        continue;
      }
      if (options.dryRun) {
        plans.push({ origin: target, action: 'append', missing: missing.length, sessionId: ref.sessionId });
        continue;
      }
      const delta: Conversation = { ...source, messages: missing };
      const result = append(delta, ref.sessionId, options);
      ref.path = result.path;
      const plan: TargetPlan = {
        origin: target,
        action: 'append',
        missing: missing.length,
        sessionId: ref.sessionId,
        path: result.path,
      };
      await recordBlocked(target, record, plan, sourceMessages);
      plans.push(plan);
    } catch (error) {
      plans.push({
        origin: target,
        action: 'create',
        missing: 0,
        sessionId: ref?.sessionId,
        error: (error as Error).message,
      });
    }
  }

  // Appends were verified by re-reading the replica afterwards (see recordBlocked),
  // so a pass without errors means every requested replica now holds the source.
  // A message counts as synced when every replica either holds it or has been
  // recorded as unable to represent it.
  if (plans.every((plan) => !plan.error)) {
    const blocked = new Set(
      plans.flatMap((plan) => record.unrepresentable?.[plan.origin] ?? []),
    );
    record.synced = sourceMessages
      .map((message) => messageFingerprint(message))
      .filter((fingerprint) => !blocked.has(fingerprint));
  }
  // Only a real write counts as activity. Touching this on every pass would make
  // the conversation jump to the top of the list on a timer.
  if (plans.some((plan) => plan.action === 'create' || (plan.action === 'append' && plan.missing > 0))) {
    record.updatedAt = Date.now();
  }
  ledger.upsert(record);
  if (!options.dryRun) ledger.save();

  return {
    groupId: record.groupId,
    source: { origin: sourceOrigin, sessionId: sourceId },
    title: source.title,
    canonicalMessages: sourceMessages.length,
    targets: plans,
  };
}

/**
 * Re-reads a replica after writing and remembers anything it still cannot hold
 * (an image whose bytes do not exist, a content type a harness has no place for).
 * Recording it stops the next run from retrying an impossible append forever.
 */
async function recordBlocked(
  target: Origin,
  record: MirrorRecord,
  plan: TargetPlan,
  sourceMessages: import('./ir.ts').Message[],
): Promise<void> {
  if (!plan.sessionId) return;
  const replica = await makeReader(target)
    .read(plan.sessionId)
    .catch(() => undefined);
  if (!replica) return;
  const still = missingMessages(canonicalize(replica.messages), sourceMessages);
  if (still.length === 0) return;
  const known = new Set(record.unrepresentable?.[target] ?? []);
  for (const message of still) known.add(messageFingerprint(message));
  record.unrepresentable = record.unrepresentable ?? {};
  record.unrepresentable[target] = [...known];
  plan.unrepresentable = still.length;
}

interface WriteOutcome {
  sessionId: string;
  path: string;
}

function writeFor(origin: Origin): (conversation: Conversation, options: MirrorOptions) => WriteOutcome {
  if (origin === 'claude') {
    return (conversation, options) => {
      const result = writeClaude(conversation, { home: options.claude });
      return { sessionId: result.sessionId, path: result.path };
    };
  }
  if (origin === 'codex') {
    return (conversation, options) => {
      const result = writeCodex(conversation, { home: options.codex, backupDir: options.backupDir });
      return { sessionId: result.threadId, path: result.path };
    };
  }
  return (conversation, options) => {
    const result = writeDsh(conversation, { home: options.dsh, backupDir: options.backupDir });
    return { sessionId: result.sessionId, path: result.path };
  };
}

function appendFor(
  origin: Origin,
): (conversation: Conversation, sessionId: string, options: MirrorOptions) => { path: string } {
  if (origin === 'claude') {
    return (conversation, sessionId, options) =>
      appendClaude(conversation, sessionId, { home: options.claude });
  }
  if (origin === 'codex') {
    return (conversation, sessionId, options) =>
      appendCodex(conversation, sessionId, { home: options.codex, backupDir: options.backupDir });
  }
  return (conversation, sessionId, options) =>
    appendDsh(conversation, sessionId, { home: options.dsh, backupDir: options.backupDir });
}

