#!/usr/bin/env node
/**
 * Real migration test through the browser.
 *
 * Actually clicks 「发送到 → …」 and checks what landed on disk: the replica files,
 * the ledger, the tree after a reload, and the transcript of the new copy. This
 * writes to the real Claude Code / DSH stores, on purpose.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://127.0.0.1:8787';
const PORT = 9335;
const OUT = '/tmp/sm-migrate';
const TARGET_TITLE = process.argv[2] ?? '高质感香氛品牌首页预览';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function waitForJson(url: string, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout: ${url}`);
}

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #events: Array<{ method: string; params: any }> = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') {
        const slot = this.#pending.get(message.id);
        if (!slot) return;
        this.#pending.delete(message.id);
        if (message.error) slot.reject(new Error(message.error.message));
        else slot.resolve(message.result);
        return;
      }
      this.#events.push({ method: message.method, params: message.params });
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 120000);
    });
  }

  events() {
    return this.#events;
  }
}

const report: any = { target: TARGET_TITLE, at: new Date().toISOString() };
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}/profile`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const version = await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method: string, params: Record<string, unknown> = {}) => browser.send(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: APP });
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
    }
    return result.result?.value;
  };
  const shot = async (name: string) => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}`, Buffer.from(image.data, 'base64'));
  };

  const waitForTree = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await evaluate("document.querySelectorAll('#tree .chat-row').length");
      if (rows > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return 0;
  };

  const waitForSearchHit = async (needle: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await evaluate(`(() => {
        const row = [...document.querySelectorAll('#tree .chat-row')]
          .find((r) => (r.textContent || '').includes(${JSON.stringify(needle)}));
        return Boolean(row);
      })()`);
      if (hit) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  };

  const openConversation = async (title: string) => {
    const ok = await evaluate(`(async () => {
      const input = document.querySelector('#search');
      input.value = ${JSON.stringify(title.slice(0, 10))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const row = [...document.querySelectorAll('#tree .chat-row')]
        .find((r) => (r.textContent || '').includes(${JSON.stringify(title.slice(0, 10))}));
      if (!row) return false;
      row.click();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return ok;
  };

  /** Clicks one item of the send menu and records the states it passes through. */
  const migrate = async (toolLabel: string) => {
    const opened = await evaluate(`(() => {
      const trigger = document.querySelector('#thread-tools .send-trigger');
      if (!trigger) return { opened: false, items: [] };
      trigger.click();
      const menu = document.querySelector('#thread-tools .send-menu');
      return { opened: true, items: menu ? [...menu.querySelectorAll('.send-item')].map((b) => b.textContent.trim()) : [] };
    })()`);

    const clicked = await evaluate(`(async () => {
      const items = [...document.querySelectorAll('#thread-tools .send-item')];
      const item = items.find((b) => (b.textContent || '').includes(${JSON.stringify(toolLabel)}));
      if (!item) return null;
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const now = [...document.querySelectorAll('#thread-tools .send-item')]
        .find((b) => (b.textContent || '').includes(${JSON.stringify(toolLabel)}));
      return { busyLabel: now?.textContent.trim() ?? null, busyClass: now?.className ?? null };
    })()`);

    if (!clicked) return { opened, clicked, final: null, wallMs: 0, error: '菜单里没有这一项' };

    const started = Date.now();
    let final: any = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      final = await evaluate(`(() => {
        const toast = document.querySelector('#toast');
        const done = [...document.querySelectorAll('#thread-tools .send-item')]
          .find((b) => (b.textContent || '').includes(${JSON.stringify(toolLabel)}));
        return {
          toast: toast && !toast.hidden ? toast.textContent : null,
          done: done ? { text: done.textContent.trim(), cls: done.className } : null,
          present: (() => {
            const t = document.querySelector('#thread-tools .send-trigger');
            return t ? t.getAttribute('aria-expanded') : null;
          })(),
        };
      })()`);
      if (final?.toast || final?.done?.cls?.includes('done')) break;
    }
    return { opened, clicked, final, wallMs: Date.now() - started };
  };

  const replicasOf = async (title: string) => {
    const payload = await (await fetch(`${APP}/api/conversations`)).json();
    const row = payload.conversations.find((c: any) => c.title.startsWith(title.slice(0, 10)));
    return row ? { key: row.key, replicas: row.replicas, projects: row.projects } : null;
  };

  /* ---- start from the Codex view ---- */
  await evaluate(`(() => {
    if (document.querySelector('#tool-label')?.textContent === 'Codex') return true;
    document.querySelector('#tool-switch').click();
    const button = [...document.querySelectorAll('#tool-menu button')]
      .find((b) => (b.textContent || '').includes('Codex'));
    button?.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  /* ---- baseline ---- */
  report.before = await replicasOf(TARGET_TITLE);
  report.beforeOpened = await openConversation(TARGET_TITLE);
  report.beforeHeader = await evaluate(`({
    title: document.querySelector('#thread-title')?.textContent,
    meta: document.querySelector('#thread-meta')?.textContent,
    turns: document.querySelectorAll('#transcript .turn.user').length,
    texts: document.querySelectorAll('#transcript > .text-block').length,
  })`);
  await shot('01-before.png');

  /* ---- migrate to Claude Code ---- */
  report.toClaude = await migrate('Claude Code');
  await shot('02-claude.png');
  report.afterClaude = await replicasOf(TARGET_TITLE);
  const claudeId = report.afterClaude?.replicas?.claude?.id ?? null;
  report.claudeFile = claudeId ? findClaudeFile(claudeId) : null;

  /* ---- migrate to DeepSeek Harness ---- */
  report.toDsh = await migrate('DeepSeek Harness');
  await shot('03-dsh.png');
  report.afterDsh = await replicasOf(TARGET_TITLE);
  const dshId = report.afterDsh?.replicas?.dsh?.id ?? null;
  report.dshFile = dshId ? findDshFile(dshId) : null;

  /* ---- the copies must read back the same ---- */
  report.absent = await evaluate(`(() => {
    const trigger = document.querySelector('#thread-tools .send-trigger');
    return { trigger: Boolean(trigger) };
  })()`);

  const compare: any = {};
  for (const origin of ['codex', 'claude', 'dsh']) {
    const replica = report.afterDsh?.replicas?.[origin];
    if (!replica) continue;
    const response = await fetch(`${APP}/api/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin, id: replica.id, all: true }),
    });
    const payload = await response.json();
    const lines = payload.lines ?? [];
    compare[origin] = {
      total: payload.total,
      texts: lines.filter((line: any) => line.kind === 'text').length,
      userTurns: lines.filter((line: any) => line.kind === 'text' && line.role === 'user').length,
      images: lines.filter((line: any) => line.kind === 'image').length,
      firstUser: lines.find((line: any) => line.kind === 'text' && line.role === 'user')?.text?.slice(0, 60) ?? null,
    };
  }
  report.compare = compare;

  /* ---- the copies show up in their own tool view ---- */
  const viewIn = async (index: number, needle: string) => {
    await evaluate(`(() => {
      document.querySelector('#tool-switch').click();
      document.querySelectorAll('#tool-menu button')[${index}]?.click();
      return true;
    })()`);
    await waitForTree();
    const hit = await evaluate(`(async () => {
      const input = document.querySelector('#search');
      input.value = ${JSON.stringify('__NEEDLE__')};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`.replace('__NEEDLE__', needle));
    return hit;
  };

  await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    document.querySelectorAll('#tool-menu button')[1]?.click();
    return true;
  })()`);
  await waitForTree();
  report.claudeView = await evaluate(`(async () => {
    const input = document.querySelector('#search');
    input.value = ${JSON.stringify(TARGET_TITLE.slice(0, 8))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const row = [...document.querySelectorAll('#tree .chat-row')][0];
    const found = Boolean(row);
    row?.click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return {
      label: document.querySelector('#tool-label')?.textContent,
      found,
      title: document.querySelector('#thread-title')?.textContent,
      texts: document.querySelectorAll('#transcript > .text-block').length,
    };
  })()`);
  await shot('04-claude-view.png');

  await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    document.querySelectorAll('#tool-menu button')[2]?.click();
    return true;
  })()`);
  await waitForTree();
  report.dshView = await evaluate(`(async () => {
    const input = document.querySelector('#search');
    input.value = ${JSON.stringify(TARGET_TITLE.slice(0, 8))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const row = [...document.querySelectorAll('#tree .chat-row')][0];
    const found = Boolean(row);
    row?.click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return {
      label: document.querySelector('#tool-label')?.textContent,
      found,
      title: document.querySelector('#thread-title')?.textContent,
      texts: document.querySelectorAll('#transcript > .text-block').length,
    };
  })()`);
  await shot('05-dsh-view.png');

  report.exceptions = browser
    .events()
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text)
    .slice(0, 6);
  report.consoleErrors = browser
    .events()
    .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
    .map((event) => event.params.args.map((arg: any) => arg.value ?? arg.description).join(' '))
    .slice(0, 6);

  fs.writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.kill('SIGTERM');
}

function findClaudeFile(id: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        return `${file} (${(fs.statSync(file).size / 1048576).toFixed(2)} MB, ${fs.readFileSync(file, 'utf8').trim().split('\n').length} lines)`;
      }
    }
  } catch {
    // not installed
  }
  return null;
}

function findDshFile(id: string): string | null {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.includes(id) || entry.name === id) {
          const file = path.join(full, 'session.v4.jsonl.zstd');
          if (fs.existsSync(file)) {
            return `${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`;
          }
        }
        stack.push(full);
      }
    }
  }
  return null;
}
