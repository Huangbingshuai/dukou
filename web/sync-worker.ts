/**
 * Sync work on its own thread.
 *
 * The readers/writers use synchronous fs + zstd + sqlite calls. Running them on
 * the HTTP loop froze every request for seconds while a big backfill appended
 * thousands of messages (measured: /api/health took 7.3s). This worker owns all
 * mirroring; the server only waits for its reply, and the event loop stays free.
 */
import { parentPort } from 'node:worker_threads';

import { mirrorConversation } from '../src/mirror.ts';
import { syncGroups } from '../src/groups.ts';
import { planTargets } from '../src/plan.ts';
import { listConversations } from './inventory.ts';
import { buildTranscript } from './transcript.ts';
import type { Origin } from '../src/ir.ts';

type Job =
  | { id: number; kind: 'add'; sourceOrigin: Origin; sourceId: string; target: Origin }
  | { id: number; kind: 'sync'; groupId?: string }
  | { id: number; kind: 'plan'; origin: Origin; sourceId: string; targets: Origin[] }
  | { id: number; kind: 'conversations' }
  | { id: number; kind: 'transcript'; origin: Origin; sourceId: string };

const port = parentPort;
if (!port) throw new Error('sync worker started without a parent port');

port.on('message', async (job: Job) => {
  try {
    const result =
      job.kind === 'add'
        ? await mirrorConversation(job.sourceOrigin, job.sourceId, [job.target])
        : job.kind === 'plan'
          ? await planTargets(job.origin, job.sourceId, job.targets)
          : job.kind === 'conversations'
            ? await listConversations()
            : job.kind === 'transcript'
              ? await buildTranscript(job.origin, job.sourceId)
              : await syncGroups(job.groupId ? { groupId: job.groupId } : {});
    port.postMessage({ id: job.id, ok: true, result });
  } catch (error) {
    port.postMessage({ id: job.id, ok: false, error: (error as Error).message });
  }
});
