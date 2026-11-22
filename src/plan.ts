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
import { missingMessages, messageFingerprint } from './ids.ts';
import { readerFor } from './readers.ts';

export interface TargetPlanSummary {
  origin: Origin;
  replica: boolean;
  missing: number;
  total: number;
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
    // Tools Codex cannot hold are settled, not "missing": the mirror records them
    // as unrepresentable, and the page must not keep advertising them as pending.
    const blocked = new Set(record?.unrepresentable?.[target] ?? []);
    const expected = blocked.size
      ? sourceMessages.filter((message) => !blocked.has(messageFingerprint(message)))
      : sourceMessages;
    let missing = expected.length;
    if (replica?.sessionId) {
      try {
        const targetConversation = await readerFor(target).read(replica.sessionId);
        missing = missingMessages(canonicalize(targetConversation.messages), expected).length;
      } catch {
        missing = expected.length;
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
