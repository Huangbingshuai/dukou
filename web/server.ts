#!/usr/bin/env node
/**
 * session-mirror web backend.
 *
 * A local HTTP service over the mirror engine: list the three stores, inspect one
 * conversation, migrate a user-chosen selection, and keep mirrored groups in
 * agreement. No framework, no dependencies — Node's http + the engine in ../src.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../src/attachments.ts';
import { canonicalize } from '../src/ir.ts';
import type { Conversation, Message, Origin } from '../src/ir.ts';
import { messageText } from '../src/ir.ts';
import { ClaudeReader } from '../src/adapters/claude.ts';
import { CodexReader } from '../src/adapters/codex.ts';
import { DshReader } from '../src/adapters/dsh.ts';
import { mirrorConversation } from '../src/mirror.ts';
import { syncGroups } from '../src/groups.ts';
import { Ledger } from '../src/ledger.ts';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { assertMigratable } from '../src/guards.ts';
import { releaseDeadLocks } from '../src/lock.ts';
import { planTargets } from '../src/plan.ts';
import { buildTranscript } from './transcript.ts';
import {
  listConversations,
  listSessions,
  loadOverrides,
  nativeProjects,
  saveOverrides,
  type ConversationRow,
  type ProjectRow,
  type SessionRow,
} from './inventory.ts';
import { missingMessages } from '../src/ids.ts';
import { HARNESSES, HARNESS_IDS, harnessOf } from '../src/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.SESSION_MIRROR_PORT ?? 8787);
const HOST = process.env.SESSION_MIRROR_HOST ?? '127.0.0.1';

const ORIGINS: Origin[] = HARNESS_IDS;
const LABELS: Record<string, string> = Object.fromEntries(HARNESSES.map((harness) => [harness.id, harness.label]));

function labelOf(id: string): string {
  return LABELS[id] ?? harnessOf(id)?.label ?? id;
}

function readerFor(origin: Origin) {
  if (origin === 'codex') return new CodexReader();
  if (origin === 'claude') return new ClaudeReader();
  return new DshReader();
}

function isOrigin(value: unknown): value is Origin {
  return typeof value === 'string' && (ORIGINS as string[]).includes(value);
}

function snippet(message: Message): string {
  const text = messageText(message);
  if (text) return text.replace(/\s+/g, ' ').slice(0, 160);
  const kinds = message.blocks.map((block) => block.type).join('+');
  return `[${kinds}]`;
}

interface InspectResult {
  origin: Origin;
  id: string;
  title: string;
  project: string;
  cwd: string;
  messages: number;
  head: Array<{ role: string; text: string }>;
  tail: Array<{ role: string; text: string }>;
  empty: boolean;
}

async function inspect(origin: Origin, id: string): Promise<InspectResult> {
  const conversation: Conversation = await readerFor(origin).read(id);
  const messages = canonicalize(conversation.messages);
  return {
    origin,
    id,
    title: conversation.title,
    project: conversation.projectName,
    cwd: conversation.cwd,
    messages: messages.length,
    head: messages.slice(0, 3).map((message) => ({ role: message.role, text: snippet(message) })),
    tail: messages.slice(-2).map((message) => ({ role: message.role, text: snippet(message) })),
    empty: messages.length === 0,
  };
}

/**
 * Images are served by content hash so the transcript stays small and the browser
 * caches each picture once, however many times it appears. The worker hands the
 * bytes back with each transcript; this map is what /api/image reads.
 */
const imageCache = new Map<string, { mime: string; bytes: Buffer; at: number }>();
const IMAGE_CACHE_LIMIT = 64 * 1024 * 1024;
let imageBytes = 0;

function cacheImage(base64: string, mime: string): string {
  const hash = sha256(base64);
  const existing = imageCache.get(hash);
  if (existing) {
    existing.at = Date.now();
    return hash;
  }
  const bytes = Buffer.from(base64, 'base64');
  imageCache.set(hash, { mime, bytes, at: Date.now() });
  imageBytes += bytes.length;
  // Bound the cache; the least recently used entries go first.
  while (imageBytes > IMAGE_CACHE_LIMIT && imageCache.size > 1) {
    const [oldestKey] = [...imageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    const removed = imageCache.get(oldestKey);
    imageCache.delete(oldestKey);
    imageBytes -= removed?.bytes.length ?? 0;
  }
  return hash;
}

function groups(): Array<Record<string, unknown>> {
  const ledger = new Ledger();
  return ledger.all().map((record) => ({
    groupId: record.groupId,
    title: record.title,
    project: record.projectName,
    cwd: record.cwd,
    replicas: record.replicas,
    updatedAt: record.updatedAt,
  }));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Can this process write the ledger? Migrations save a temp file beside it and
 * rename, so a read-only directory shows up as a bare EPERM on every button.
 * Probing once lets the page say what is wrong instead of failing at click time.
 */
function probeLedgerWrite(): { ok: boolean; error?: string } {
  const file = new Ledger().file;
  const probe = path.join(path.dirname(file), `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, relative);
  if (!file.startsWith(PUBLIC)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* ---------- realtime ---------- */

/** Pages listening for "a pass just converged the replicas". */
const listeners = new Set<http.ServerResponse>();

function broadcast(event: string, payload: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners) {
    try {
      listener.write(frame);
    } catch {
      listeners.delete(listener);
    }
  }
}

let passRunning = false;
async function runPass(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    const results = await runSyncJob({ kind: 'sync' });
    const changed = results.reduce((sum, group) => sum + group.changed.length, 0);
    if (changed > 0) broadcast('synced', { changed, groups: results.length });
  } catch (error) {
    console.warn(`realtime pass failed: ${(error as Error).message}`);
  } finally {
    passRunning = false;
  }
}

/**
 * Watches the three stores and runs one debounced pass after a change, so a new
 * message shows up in the other harnesses about a second after it is written.
 * The interval is only a safety net for a missed file event.
 */
function startWatching(): () => void {
  const home = process.env.HOME ?? os.homedir();
  const roots = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.codex', 'sessions'),
    path.join(home, '.dsh', 'sessions'),
  ];
  let scheduled: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void runPass();
    }, 1500);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const root of roots) {
    try {
      watchers.push(fs.watch(root, { recursive: true, persistent: false }, schedule));
    } catch {
      // A machine without that harness simply has nothing to watch.
    }
  }
  // File watchers already fire on real changes; the timer is only a safety net.
  // A one-minute beat re-read every replica even when nothing happened, and a
  // large backfill (thousands of messages) blocks the HTTP loop while it runs.
  const interval = setInterval(() => void runPass(), 5 * 60_000);
  return () => {
    if (scheduled) clearTimeout(scheduled);
    clearInterval(interval);
    for (const watcher of watchers) watcher.close();
  };
}


/* ---------- sync worker ---------- */

/**
 * Mirroring runs in a worker thread: the readers and writers are synchronous
 * (zstd, sqlite, file appends), and a multi-thousand-message backfill used to
 * freeze every other request on this loop. If a worker cannot be started at all
 * the same jobs run in-process, so the app degrades instead of breaking.
 */
type SyncJob =
  | { kind: 'add'; sourceOrigin: Origin; sourceId: string; target: Origin }
  | { kind: 'migrate'; sourceOrigin: Origin; sourceId: string; targets: Origin[] }
  | { kind: 'sync'; groupId?: string }
  | { kind: 'plan'; origin: Origin; sourceId: string; targets: Origin[] }
  | { kind: 'conversations' }
  | { kind: 'transcript'; origin: Origin; sourceId: string };

type Lane = 'read' | 'write';

interface LaneState {
  worker: Worker | null;
  unavailable: boolean;
  seq: number;
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>;
}

/**
 * Two lanes, not one: a long backfill must never queue the page's reads behind
 * it. Reads (inventory, plan, transcript) and writes (add/sync/migrate) each get
 * their own worker.
 */
const lanes: Record<Lane, LaneState> = {
  read: { worker: null, unavailable: false, seq: 0, pending: new Map() },
  write: { worker: null, unavailable: false, seq: 0, pending: new Map() },
};

function getWorker(lane: Lane): Worker | null {
  const state = lanes[lane];
  if (state.unavailable) return null;
  if (state.worker) return state.worker;
  try {
    const worker = new Worker(new URL('./sync-worker.ts', import.meta.url));
    worker.on('message', (message: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (typeof message.id !== 'number') return;
      const job = state.pending.get(message.id);
      if (!job) return;
      state.pending.delete(message.id);
      if (message.ok) job.resolve(message.result);
      else job.reject(new Error(message.error ?? 'job failed'));
    });
    worker.on('error', (error) => {
      console.warn(`${lane} worker failed: ${error.message}`);
      state.unavailable = true;
      state.worker = null;
      for (const job of state.pending.values()) job.reject(error);
      state.pending.clear();
    });
    worker.unref();
    state.worker = worker;
    return worker;
  } catch (error) {
    console.warn(`${lane} worker unavailable: ${(error as Error).message}`);
    state.unavailable = true;
    return null;
  }
}

async function runInProcess(job: SyncJob): Promise<any> {
  if (job.kind === 'add') return mirrorConversation(job.sourceOrigin, job.sourceId, [job.target]);
  if (job.kind === 'migrate') return mirrorConversation(job.sourceOrigin, job.sourceId, job.targets);
  if (job.kind === 'plan') return planTargets(job.origin, job.sourceId, job.targets);
  if (job.kind === 'conversations') return listConversations();
  if (job.kind === 'transcript') return buildTranscript(job.origin, job.sourceId);
  return syncGroups(job.groupId ? { groupId: job.groupId } : {});
}

function laneFor(job: SyncJob): Lane {
  return job.kind === 'add' || job.kind === 'migrate' || job.kind === 'sync' ? 'write' : 'read';
}

function runSyncJob(job: SyncJob): Promise<any> {
  const lane = laneFor(job);
  const worker = getWorker(lane);
  if (!worker) return runInProcess(job);
  const state = lanes[lane];
  const id = ++state.seq;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...job });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      // Listing every store is the page's most frequent heavy read.
      return json(res, 200, await runSyncJob({ kind: 'conversations' }));
    }

    if (req.method === 'GET' && url.pathname === '/api/plan') {
      const origin = url.searchParams.get('origin') ?? '';
      const id = url.searchParams.get('id') ?? '';
      if (!isOrigin(origin) || !id) return json(res, 400, { error: 'origin and id are required' });
      try {
        // Reading a large conversation takes a while; keep it off the HTTP loop.
        const targets = await runSyncJob({ kind: 'plan', origin, sourceId: id, targets: ORIGINS });
        return json(res, 200, {
          ok: true,
          targets: targets.map((entry: { origin: Origin; replica: boolean; missing: number; total: number }) => ({
            ...entry,
            label: labelOf(entry.origin),
          })),
        });
      } catch (error) {
        return json(res, 400, { ok: false, error: (error as Error).message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/add') {
      const body = (await readBody(req)) as {
        sourceOrigin?: unknown;
        sourceId?: unknown;
        target?: unknown;
      };
      if (!isOrigin(body.sourceOrigin) || typeof body.sourceId !== 'string' || !isOrigin(body.target)) {
        return json(res, 400, { error: 'sourceOrigin, sourceId and target are required' });
      }
      if (body.sourceOrigin === body.target) {
        return json(res, 400, { error: 'source and target are the same harness' });
      }
      try {
        await assertMigratable(body.sourceOrigin, body.sourceId);
        const result = await runSyncJob({ kind: 'add', sourceOrigin: body.sourceOrigin, sourceId: body.sourceId, target: body.target });
        const plan = result.targets.find((entry) => entry.origin === body.target);
        broadcast('migrated', { sources: 1 });
        // The button is one-way by nature ("send this to X"), but the group is a
        // shared conversation: let the other side's own new messages come back
        // right away instead of waiting for the next realtime pass.
        const record = new Ledger().all().find(
          (entry) => entry.replicas?.[body.sourceOrigin as Origin]?.sessionId === body.sourceId,
        );
        if (record) void runSyncJob({ kind: 'sync', groupId: record.groupId }).catch(() => undefined);
        return json(res, 200, {
          ok: true,
          title: result.title,
          messages: result.canonicalMessages,
          action: plan?.action,
          missing: plan?.missing,
          sessionId: plan?.sessionId,
          error: plan?.error,
        });
      } catch (error) {
        return json(res, 400, { ok: false, error: (error as Error).message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const filter = url.searchParams.get('origin') ?? 'all';
      const payload = await listSessions(ORIGINS.includes(filter as Origin) || filter === 'all' ? filter : 'all');
      return json(res, 200, payload);
    }

    // Screenshots live in docs/screenshots; serving them under the app's origin
    // lets a chat client render them, which a bare workspace path cannot.
    if (req.method === 'GET' && url.pathname.startsWith('/api/shot/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/shot/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(res, 400, { error: 'bad screenshot name' });
      const file = path.resolve(HERE, '..', 'docs', 'screenshots', name);
      const root = path.resolve(HERE, '..', 'docs', 'screenshots');
      if (!file.startsWith(root) || !fs.existsSync(file)) return json(res, 404, { error: 'no such screenshot' });
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
      const hash = url.pathname.slice('/api/image/'.length);
      const cached = imageCache.get(hash);
      if (!cached) return json(res, 404, { error: 'image not cached' });
      cached.at = Date.now();
      res.writeHead(200, {
        'content-type': cached.mime,
        'content-length': cached.bytes.length,
        'cache-control': 'public, max-age=86400, immutable',
      });
      res.end(cached.bytes);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/assign') {
      const body = (await readBody(req)) as { origin?: unknown; id?: unknown; projectId?: unknown };
      if (!isOrigin(body.origin) || typeof body.id !== 'string') {
        return json(res, 400, { error: 'origin and id are required' });
      }
      const overrides = loadOverrides();
      const bucket = (overrides[body.origin] ??= {});
      if (body.projectId === null || body.projectId === '') delete bucket[body.id];
      else if (typeof body.projectId === 'string') bucket[body.id] = body.projectId;
      else return json(res, 400, { error: 'projectId must be a string or null' });
      saveOverrides(overrides);
      broadcast('migrated', { sources: 0 });
      return json(res, 200, { ok: true, overrides: overrides[body.origin] });
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const harness = url.searchParams.get('harness');
      if (!isOrigin(harness)) return json(res, 400, { error: 'harness is required' });
      return json(res, 200, { projects: nativeProjects(harness) });
    }

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      return json(res, 200, { groups: groups() });
    }

    if (req.method === 'POST' && url.pathname === '/api/transcript') {
      const body = (await readBody(req)) as { origin?: unknown; id?: unknown; before?: unknown; limit?: unknown };
      if (!isOrigin(body.origin) || typeof body.id !== 'string') {
        return json(res, 400, { error: 'origin and id are required' });
      }
      try {
        // Reading a conversation is the page's slowest request; the worker also
        // hands back the image bytes the HTTP cache serves at /api/image/<hash>.
        const built = (await runSyncJob({ kind: 'transcript', origin: body.origin, sourceId: body.id })) as {
          lines: unknown[];
          images: Array<{ base64: string; mime: string }>;
        };
        for (const image of built.images ?? []) cacheImage(image.base64, image.mime);
        const all = built.lines ?? [];
        if (body.all === true) {
          return json(res, 200, { lines: all, total: all.length, start: 0, hasMore: false });
        }
        const limit = Math.min(Math.max(Number(body.limit) || 400, 20), 5000);
        const before = Math.min(Math.max(Number(body.before) || all.length, 0), all.length);
        const start = Math.max(0, before - limit);
        return json(res, 200, {
          lines: all.slice(start, before),
          total: all.length,
          start,
          hasMore: start > 0,
        });
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/inspect') {
      const body = (await readBody(req)) as { origin?: unknown; id?: unknown };
      if (!isOrigin(body.origin) || typeof body.id !== 'string') return json(res, 400, { error: 'origin and id are required' });
      return json(res, 200, await inspect(body.origin, body.id));
    }

    if (req.method === 'POST' && url.pathname === '/api/migrate') {
      const body = (await readBody(req)) as { sources?: unknown; targets?: unknown };
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const targets = Array.isArray(body.targets)
        ? (body.targets.filter(isOrigin) as Origin[])
        : ([] as Origin[]);
      if (sources.length === 0) return json(res, 400, { error: 'sources is required' });
      if (targets.length === 0) return json(res, 400, { error: 'targets is required' });

      // One NDJSON line per source, so the page can show progress as it happens.
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      for (const raw of sources) {
        const source = raw as { origin?: unknown; id?: unknown };
        const started = Date.now();
        if (!isOrigin(source.origin) || typeof source.id !== 'string') {
          res.write(`${JSON.stringify({ ok: false, error: 'bad source', source: raw })}\n`);
          continue;
        }
        try {
          await assertMigratable(source.origin, source.id);
          const result = await runSyncJob({ kind: 'migrate', sourceOrigin: source.origin, sourceId: source.id, targets });
          res.write(
            `${JSON.stringify({
              ok: true,
              source: { origin: source.origin, id: source.id },
              title: result.title,
              messages: result.canonicalMessages,
              targets: result.targets.map((plan) => ({
                origin: plan.origin,
                action: plan.action,
                missing: plan.missing,
                sessionId: plan.sessionId,
                error: plan.error,
              })),
              ms: Date.now() - started,
            })}\n`,
          );
        } catch (error) {
          res.write(
            `${JSON.stringify({
              ok: false,
              source: { origin: source.origin, id: source.id },
              error: (error as Error).message,
              ms: Date.now() - started,
            })}\n`,
          );
        }
      }
      res.end();
      broadcast('migrated', { sources: sources.length });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = (await readBody(req)) as { groupId?: unknown };
      const groupId = typeof body.groupId === 'string' ? body.groupId : undefined;
      const filtered = await runSyncJob({ kind: 'sync', groupId });
      broadcast('synced', { changed: filtered.reduce((sum: number, row: any) => sum + row.changed.length, 0), groups: filtered.length });
      return json(res, 200, { groups: filtered });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('event: ready\ndata: {}\n\n');
      listeners.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        listeners.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const file = new Ledger().file;
      // Writes land next to the ledger (temp file + rename), so a directory that
      // refuses writes makes every migration fail with a bare EPERM.
      return json(res, 200, { ok: true, port: PORT, ledger: file, writable: probeLedgerWrite() });
    }

    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

    json(res, 404, { error: `no route for ${route}` });
  } catch (error) {
    json(res, 500, { error: (error as Error).message });
  }
});

const released = releaseDeadLocks();
if (released > 0) console.log(`released ${released} stale group lock(s)`);
const stopWatching = startWatching();

server.listen(PORT, HOST, () => {
  console.log(`session-mirror web on http://${HOST}:${PORT}`);
  console.log(`ledger: ${new Ledger().file}`);
  console.log('watching ~/.claude, ~/.codex, ~/.dsh for changes');
  const writable = probeLedgerWrite();
  if (writable.ok) console.log('ledger writable: yes');
  else console.log(`ledger writable: NO — ${writable.error}\n（迁移会在保存台账时失败；请在工作区外或关闭沙箱启动）`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopWatching();
    server.close(() => process.exit(0));
  });
}
