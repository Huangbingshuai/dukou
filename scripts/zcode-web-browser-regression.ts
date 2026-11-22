#!/usr/bin/env node
/** Browser-level send-to-ZCode integration using isolated temporary stores. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Conversation } from '../src/ir.ts';
import { writeClaude } from '../src/writers/claude.ts';

const NODE = process.env.DSH_NODE_EXECUTABLE ?? process.execPath;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SESSION_MIRROR_PORT ?? 8878);
const CDP_PORT = 9335;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dukou-zcode-browser-'));
const home = path.join(root, 'home');
const claudeHome = path.join(root, 'claude');
const zcodeHome = path.join(root, 'zcode');
const profile = path.join(root, 'chrome-profile');
const title = 'Please inspect these two images in their original order.';
let server: ReturnType<typeof spawn> | undefined;
let chrome: ReturnType<typeof spawn> | undefined;

function initZcodeStores(): void {
  const dbDir = path.join(zcodeHome, 'cli', 'db');
  const v2Dir = path.join(zcodeHome, 'v2');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(v2Dir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'db.sqlite'));
  db.exec(`create table session(id text primary key, project_id text not null, workspace_id text, parent_id text, slug text not null, directory text not null, path text, title text not null, version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text, permission text, time_created integer not null, time_updated integer not null, time_compacting integer, time_archived integer, task_type text not null default 'interactive', title_source text not null default 'first_input', title_message_id text, time_title_updated integer, trace_id text, time_deleted integer, last_outcome text);
    create table message(id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);
    create table part(id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);`);
  db.close();
  const index = new DatabaseSync(path.join(v2Dir, 'tasks-index.sqlite'));
  index.exec(`create table tasks (workspace_key text not null, workspace_path text not null, task_id text not null, title text not null default '', task_status text, provider text, mode text not null default 'build', created_at integer not null, updated_at integer not null, archived integer not null default 0, deleted integer not null default 0, meta_json text not null default '{}', searchable_text text not null default '', cli_title text, cli_created_at integer, cli_updated_at integer, project_id text, root_path text, primary key(workspace_key, task_id));
    create table projects (project_id text primary key, host_id text, name text, position integer, pinned integer, deleted integer, created_at integer, updated_at integer);
    create table project_roots (project_id text, root_path text, position integer, is_primary integer, primary key(project_id, root_path));`);
  index.prepare('insert into projects (project_id, host_id, name, position, pinned, deleted, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)').run('browser-test-project', 'local', 'Browser test', 0, 0, 0, Date.now(), Date.now());
  index.prepare('insert into project_roots (project_id, root_path, position, is_primary) values (?, ?, ?, ?)').run('browser-test-project', path.join(root, 'workspace'), 0, 1);
  index.close();
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch { /* page or server is still booting */ }
    await wait(150);
  }
  throw new Error('browser integration timed out');
}

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('Chrome DevTools connection failed')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`Chrome DevTools timeout: ${method}`));
      }, 30000);
    });
  }
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json() as T;
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  initZcodeStores();
  const now = Date.now();
  const conversation: Conversation = {
    origin: 'claude', sourceId: 'source', projectName: 'Browser test', cwd: path.join(root, 'workspace'),
    title, createdAt: now, updatedAt: now + 5000, archived: false, path: path.join(claudeHome, 'fixture.jsonl'),
    messages: [
      { id: 'u1', role: 'user', time: now, blocks: [{ type: 'text', text: 'Please inspect these two images in their original order.' }, { type: 'image', mime: 'image/png', ref: '', data: png }] },
      { id: 'a1', role: 'assistant', time: now + 1000, blocks: [{ type: 'toolCall', callId: 'call-1', name: 'read', input: '{"path":"demo.txt"}' }, { type: 'toolResult', callId: 'call-1', output: 'fixture output', images: [{ type: 'image', mime: 'image/png', ref: '', data: png }] }, { type: 'text', text: 'Both images and the tool result were retained in order.' }] },
    ],
  };
  writeClaude(conversation, { home: claudeHome });

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_HOME: claudeHome,
    DSH_HOME: path.join(root, 'dsh'),
    KIMI_CODE_HOME: path.join(root, 'kimi'),
    ZCODE_HOME: zcodeHome,
    SESSION_MIRROR_PORT: String(PORT),
    ELECTRON_RUN_AS_NODE: '1',
  };
  server = spawn(NODE, ['web/server.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: 'ignore' });
  await waitFor(async () => {
    try { return await json<{ conversations?: unknown[] }>(`http://127.0.0.1:${PORT}/api/conversations`); }
    catch { return false; }
  });

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const version = await waitFor(() => json<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${CDP_PORT}/json/version`));
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method: string, params: Record<string, unknown> = {}) => browser.send(method, params, sessionId);
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'browser evaluation failed');
    return result.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
  await waitFor(() => evaluate("document.querySelector('#tool-switch')?.textContent?.trim()"));
  await waitFor(() => evaluate("document.querySelectorAll('#tool-menu button').length === 5"));

  await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    const item = [...document.querySelectorAll('#tool-menu button')].find((button) => button.innerText.includes('Claude Code'));
    if (!item) throw new Error('Claude Code source missing from tool menu');
    item.click();
  })()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('#tree .chat-name')].some((name) => name.textContent === ${JSON.stringify(title)})`));
  await evaluate(`(() => [...document.querySelectorAll('#tree .chat-row')].find((row) => row.querySelector('.chat-name')?.textContent === ${JSON.stringify(title)}).click())()`);
  await waitFor(() => evaluate("document.querySelector('#thread-tools .send-trigger')"));
  await waitFor(() => evaluate("document.querySelector('#transcript .msg-image')"));
  await evaluate("document.querySelector('#thread-tools .send-trigger').click()");
  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__dukouLastAdd = null;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes('/api/add')) {
        window.__dukouLastAdd = { status: response.status, body: await response.clone().json() };
      }
      return response;
    };
    const target = [...document.querySelectorAll('#thread-tools .send-item')].find((item) => item.textContent.includes('发送到 ZCode'));
    if (!target) throw new Error('ZCode send menu item was not rendered');
    target.click();
    return true;
  })()`);
  const sendResponse = await waitFor(() => evaluate('window.__dukouLastAdd'), 30000);
  if (sendResponse.status !== 200 || !sendResponse.body?.ok || sendResponse.body.error) throw new Error(`Web UI failed to send to ZCode: ${JSON.stringify(sendResponse)}`);

  const inventory = await waitFor(async () => {
    await evaluate("document.querySelector('#refresh').click()");
    const result = await json<{ conversations: Array<{ title: string; replicas: Record<string, { id: string }> }> }>(`http://127.0.0.1:${PORT}/api/conversations`);
    return result.conversations.find((row) => row.title === title && row.replicas.zcode) || false;
  });
  const zcodeId = inventory.replicas.zcode.id;
  const transcriptResponse = await fetch(`http://127.0.0.1:${PORT}/api/transcript`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: 'zcode', id: zcodeId, all: true }),
  });
  const transcript = await transcriptResponse.json() as { lines: Array<{ kind: string; role: string; text: string; src?: string }>; error?: string };
  if (!transcriptResponse.ok || transcript.error) throw new Error(transcript.error ?? `ZCode transcript failed: ${transcriptResponse.status}`);
  const ordered = transcript.lines.map((line) => line.kind === 'image' ? `image:${line.role}` : `${line.kind}:${line.text}`);
  if (ordered.length !== 6 || !ordered[0].includes('Please inspect') || !ordered[1].startsWith('image:user') || !ordered[2].includes('read') || !ordered[3].includes('fixture output') || !ordered[4].startsWith('image:tool') || !ordered[5].includes('Both images')) {
    throw new Error(`ZCode transcript order or content mismatch: ${JSON.stringify(ordered)}`);
  }

  await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    [...document.querySelectorAll('#tool-menu button')].find((button) => button.innerText.includes('ZCode')).click();
  })()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('#tree .chat-name')].some((name) => name.textContent === ${JSON.stringify(title)})`));
  await evaluate(`(() => [...document.querySelectorAll('#tree .chat-row')].find((row) => row.querySelector('.chat-name')?.textContent === ${JSON.stringify(title)}).click())()`);
  const visible = await waitFor(() => evaluate(`(() => {
    const images = [...document.querySelectorAll('#transcript img')];
    const children = [...document.querySelector('#transcript').children].map((node) => node.className);
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)
      ? { images: images.length, order: children, text: document.querySelector('#transcript').innerText }
      : false;
  })()`), 30000);
  if (!visible.text.includes('Both images and the tool result were retained in order.')) throw new Error('ZCode browser transcript did not render the final answer');
  if (visible.order.indexOf('turn user') >= visible.order.indexOf('msg-image') || visible.order.indexOf('activity-fold') >= visible.order.indexOf('text-block')) {
    throw new Error(`ZCode browser transcript rendered messages out of order: ${JSON.stringify(visible.order)}`);
  }
  console.log(JSON.stringify({ ok: true, source: 'Claude Code', target: 'ZCode', messages: ordered.length, visibleImages: visible.images, order: visible.order }));
  await browser.send('Target.closeTarget', { targetId });
} finally {
  chrome?.kill('SIGTERM');
  server?.kill('SIGTERM');
  await wait(500);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
