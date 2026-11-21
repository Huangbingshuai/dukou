#!/usr/bin/env node
/**
 * Rebuilds mirror-created Codex threads from their source replicas.
 *
 * Two writer bugs made Codex show a truncated conversation:
 *   1. appends restarted `item-N` / `mirror-turn-N` numbering, so the app's
 *      projection dropped every message whose id it had already seen;
 *   2. user-message event items used the API content type `input_text` instead of
 *      the `text` its projection expects, so human turns were skipped outright.
 *
 * The rollout is append-only, so the way back is a full rewrite plus dropping the
 * projection rows: Codex folds the thread again the next time it is opened.
 */
import { DshReader } from '../src/adapters/dsh.ts';
import { ClaudeReader } from '../src/adapters/claude.ts';
import { Ledger } from '../src/ledger.ts';
import { codexThreadInfo, rewriteCodex } from '../src/writers/codex.ts';

const dryRun = process.argv.includes('--dry-run');
const ledger = new Ledger();
const records = ledger.all().filter((record) => record.replicas?.codex);

console.log(`mirrored codex sessions: ${records.length}${dryRun ? ' (dry run)' : ''}`);

for (const record of records) {
  const replica = record.replicas.codex;
  const info = codexThreadInfo(replica.sessionId);
  if (!info) {
    console.log(`- ${record.title.slice(0, 28)} [${replica.sessionId.slice(0, 8)}] skipped: thread missing`);
    continue;
  }
  // Native threads belong to Codex itself; only rewrite what the mirror wrote.
  if (info.originator !== 'session-mirror') {
    console.log(`- ${record.title.slice(0, 28)} [${replica.sessionId.slice(0, 8)}] skipped: native thread`);
    continue;
  }
  const source = record.replicas.dsh ? 'dsh' : record.replicas.claude ? 'claude' : null;
  if (!source) {
    console.log(`- ${record.title.slice(0, 28)} [${replica.sessionId.slice(0, 8)}] skipped: no source replica`);
    continue;
  }
  console.log(`- ${record.title.slice(0, 28)} [${replica.sessionId.slice(0, 8)}] source=${source}`);
  if (dryRun) continue;

  const reader = source === 'dsh' ? new DshReader() : new ClaudeReader();
  const conversation = await reader.read(record.replicas[source].sessionId);
  const result = rewriteCodex(conversation, replica.sessionId);
  console.log(`  rewritten: ${result.rows} rows`);
}
