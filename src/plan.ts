/**
 * Read-only planning: how far behind is each other harness?
 *
 * Lives outside the HTTP layer so it can run in the sync worker — reading a large
 * conversation takes a few hundred milliseconds, and the page asks for this every
 * time a conversation is selected.
 */
import type { Origin } from './ir.ts';
import { canonicalize } from './ir.ts';
import { Ledger } from './ledger.ts';
import { missingMessages } from './ids.ts';
import { ClaudeReader } from './adapters/claude.ts';
import { CodexReader } from './adapters/codex.ts';
import { DshReader } from './adapters/dsh.ts';

export interface TargetPlanSummary {
  origin: Origin;
  replica: boolean;
  missing: number;
  total: number;
}

function readerFor(origin: Origin) {
  if (origin === 'codex') return new CodexReader();
  if (origin === 'claude') return new ClaudeReader();
  return new DshReader();
}

export async function planTargets(
  origin: Origin,
  sourceId: string,
  origins: Origin[],
): Promise<TargetPlanSummary[]> {
  const conversation = await readerFor(origin).read(sourceId);
  const sourceMessages = canonicalize(conversation.messages);
  const ledger = new Ledger();
  const record = ledger.all().find((entry) => entry.replicas?.[origin]?.sessionId === sourceId);
  const out: TargetPlanSummary[] = [];
  for (const target of origins) {
    if (target === origin) continue;
    const replica = record?.replicas?.[target];
    let missing = sourceMessages.length;
    if (replica?.sessionId) {
      try {
        const targetConversation = await readerFor(target).read(replica.sessionId);
        missing = missingMessages(canonicalize(targetConversation.messages), sourceMessages).length;
      } catch {
        missing = sourceMessages.length;
      }
    }
    out.push({
      origin: target,
      replica: Boolean(replica?.sessionId),
      missing: Math.max(0, missing),
      total: sourceMessages.length,
    });
  }
  return out;
}
