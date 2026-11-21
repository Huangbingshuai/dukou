import fs from 'node:fs';
import path from 'node:path';

import type { Origin } from './ir.ts';
import { DSH_HOME } from './paths.ts';

/**
 * One record per mirrored conversation group: which native session id it has in
 * each harness, and which message fingerprints every replica already holds.
 *
 * The ledger is the only reason a second sync can be cheap and idempotent; it is
 * plain JSON so a human can inspect or repair it.
 */

export interface ReplicaRef {
  sessionId: string;
  path?: string;
}

export interface MirrorRecord {
  groupId: string;
  title: string;
  cwd: string;
  projectName: string;
  replicas: Partial<Record<Origin, ReplicaRef>>;
  /** Fingerprints already confirmed present in every replica. */
  synced: string[];
  /**
   * Fingerprints a given harness cannot represent (for example an image the
   * source never stored bytes for). Recorded so a mirror run does not retry the
   * same impossible append forever.
   */
  unrepresentable?: Partial<Record<Origin, string[]>>;
  createdAt: number;
  updatedAt: number;
}

interface LedgerFile {
  version: 1;
  records: Record<string, MirrorRecord>;
}

export class Ledger {
  #file: string;
  #data: LedgerFile;

  constructor(file?: string) {
    this.#file = file ?? path.join(DSH_HOME, 'migration-ledgers', 'session-mirror.json');
    this.#data = readLedger(this.#file);
  }

  get file(): string {
    return this.#file;
  }

  get(groupId: string): MirrorRecord | undefined {
    return this.#data.records[groupId];
  }

  all(): MirrorRecord[] {
    return Object.values(this.#data.records).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Finds the group that already owns a replica of this origin/session. */
  findByReplica(origin: Origin, sessionId: string): MirrorRecord | undefined {
    return this.all().find((record) => record.replicas[origin]?.sessionId === sessionId);
  }

  upsert(record: MirrorRecord): void {
    this.#data.records[record.groupId] = record;
  }

  save(): void {
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.#file);
  }
}

function readLedger(file: string): LedgerFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerFile;
    if (parsed?.version === 1 && parsed.records) return parsed;
  } catch {
    // A missing or unreadable ledger starts empty; sessions themselves are untouched.
  }
  return { version: 1, records: {} };
}
