#!/usr/bin/env node
/**
 * Rewrites every mirrored DSH session from its source replica.
 *
 * The first version of the DSH writer omitted the message id on tool results, which
 * the app rejects as a corrupt log. Re-creating the replicas with the fixed writer is
 * the only way back: the log is append-only, so a bad frame cannot be patched.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Ledger } from '../src/ledger.ts';
import { mirrorConversation } from '../src/mirror.ts';

const dryRun = process.argv.includes('--dry-run');
const ledger = new Ledger();
const records = ledger.all().filter((record) => record.replicas?.dsh);
console.log(`mirrored dsh sessions: ${records.length}${dryRun ? ' (dry run)' : ''}`);

for (const record of records) {
  const replica = record.replicas.dsh;
  const dir = replica.path ? path.dirname(replica.path) : null;
  const source = record.replicas.codex ? 'codex' : record.replicas.claude ? 'claude' : null;
  console.log(`- ${record.title.slice(0, 28)} [${replica.sessionId.slice(0, 16)}] source=${source ?? 'none'}`);
  if (!source) {
    console.log('  skipped: no other replica to read from');
    continue;
  }
  if (dryRun) continue;

  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  delete record.replicas.dsh;
  ledger.upsert(record);
  ledger.save();

  const result = await mirrorConversation(source, record.replicas[source].sessionId, ['dsh']);
  const plan = result.targets.find((entry) => entry.origin === 'dsh');
  console.log(`  rewritten: ${plan?.action} ${plan?.sessionId ?? ''} ${plan?.error ?? ''}`);
}
