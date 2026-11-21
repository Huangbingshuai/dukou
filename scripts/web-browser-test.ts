#!/usr/bin/env node
/**
 * Browser test for 渡口 (the web app).
 *
 * Read-only: rendering, tree, transcript, tool groups, the send menu and the
 * project page. Writing a replica is never done here.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:8787';
const PORT = 9334;
const OUT = '/tmp/sm-web';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function waitForJson(url: string, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
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
      ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
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
      }, 30000);
    });
  }

  events() {
    return this.#events;
  }
}

const report: Record<string, unknown> = { app: APP };
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${OUT}/profile`,
    '--no-first-run',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
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
  // The first paint depends on the store scan (now on a worker); wait for the tree
  // instead of guessing a duration.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return result.result?.value;
  };
  const waitFor = async (expression: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch {
        // the page is still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  };
  const shot = async (name: string) => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}`, Buffer.from(image.data, 'base64'));
  };

  /* ---- 1. shell and tree ---- */
  await waitFor("document.querySelectorAll('#tree .project-row').length > 0");
  report.title = await evaluate('document.title');
  report.tool = await evaluate("document.querySelector('#tool-label')?.textContent");
  report.projects = await evaluate(`[...document.querySelectorAll('#tree .project-row')].map((row) => ({
    name: row.querySelector('.project-name')?.textContent,
    count: row.querySelector('.project-count')?.textContent,
    empty: row.classList.contains('empty'),
  }))`);
  report.menu = await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    const items = [...document.querySelectorAll('#tool-menu button')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim());
    document.querySelector('#tool-switch').click();
    return items;
  })()`);
  await shot('01-tree.png');

  /* ---- 1b. an expanded project lists all of its chats ---- */
  report.defaultVisible = await evaluate(`(async () => {
    const payload = await (await fetch('/api/conversations')).json();
    const total = payload.conversations.filter((c) => c.replicas.codex).length;
    return { total, visible: document.querySelectorAll('#tree .chat-row').length };
  })()`);
  report.expansion = await evaluate(`(async () => {
    const payload = await (await fetch('/api/conversations')).json();
    const total = payload.conversations.filter((c) => c.replicas.codex).length;
    return {
      expected: total,
      projects: document.querySelectorAll('#tree .project-row').length,
      visible: document.querySelectorAll('#tree .chat-row').length,
      zeros: [...document.querySelectorAll('#tree .project-count')].filter((n) => n.textContent === '0').length,
    };
  })()`);

  await shot('01b-expanded.png');

  /* ---- 2. open a conversation that is missing a tool ---- */
  report.opened = await evaluate(`(async () => {
    const payload = await (await fetch('/api/conversations')).json();
    const target =
      payload.conversations.find((c) => c.title === '接入主流模型' && c.replicas.codex) ??
      payload.conversations.find((c) => c.replicas.codex && Object.keys(c.replicas).length === 1);
    if (!target) return null;
    const name = target.title.replace(/\\s+/g, ' ').trim();
    const input = document.querySelector('#search');
    input.value = name.slice(0, 10);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = [...document.querySelectorAll('#tree .chat-row')].find((r) => (r.textContent || '').includes(name.slice(0, 10)));
    if (!row) return 'row not found';
    row.click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return name;
  })()`);
  await waitFor("document.querySelectorAll('#transcript .turn, #transcript .text-block').length > 0", 20000);

  report.assign = await evaluate(`(() => {
    const trigger = document.querySelector('#thread-meta .assign');
    if (!trigger) return null;
    trigger.click();
    const menu = document.querySelector('.assign-menu');
    const items = menu ? [...menu.querySelectorAll('.assign-item')].map((b) => b.textContent) : [];
    const current = menu?.querySelector('.assign-item.current')?.textContent ?? null;
    trigger.click();
    return { label: trigger.textContent, count: items.length, current, hasUnfiled: items.includes('未归类') };
  })()`);
  report.layout = await evaluate(`(() => {
    const first = document.querySelector('#transcript').firstElementChild;
    const bubbles = [...document.querySelectorAll('#transcript .turn.user')];
    return {
      firstKind: first?.className ?? null,
      userBubbles: bubbles.length,
      userAlign: bubbles[0] ? getComputedStyle(bubbles[0]).justifyContent : null,
      userText: bubbles[0]?.innerText?.slice(0, 40) ?? null,
      assistantInline: document.querySelectorAll('#transcript > .text-block').length,
    };
  })()`);
  report.paging = await evaluate(`({
    buttons: document.querySelectorAll('#transcript .load-more').length,
    texts: document.querySelectorAll('#transcript > .text-block').length,
    turns: document.querySelectorAll('#transcript .turn.user').length,
  })`);

  report.thread = await evaluate(`({
    title: document.querySelector('#thread-title')?.textContent,
    meta: document.querySelector('#thread-meta')?.textContent,
    turns: document.querySelectorAll('#transcript .turn').length,
    texts: document.querySelectorAll('#transcript .text-block').length,
    folds: document.querySelectorAll('#transcript .activity-fold').length,
    inlineTools: document.querySelectorAll('#transcript > .tool').length,
    firstFold: document.querySelector('#transcript .activity-fold summary')?.textContent,
  })`);

  /* ---- 3. tool rows expand on click ---- */
  report.toolRow = await evaluate(`(() => {
    const group = document.querySelector('#transcript .activity-fold');
    if (!group) return null;
    group.open = true;
    const row = group.querySelector('.tool');
    if (!row) return null;
    const before = Math.round(row.getBoundingClientRect().height);
    return { before, after: before };
  })()`);

  report.scrolled = await evaluate(`(() => {
    const bubble = document.querySelector('#transcript .turn.user');
    if (!bubble) return false;
    bubble.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await shot('04-qa.png');

  /* ---- 4. send menu ---- */
  report.send = await evaluate(`(() => {
    const trigger = document.querySelector('#thread-tools .send-trigger');
    if (!trigger) return { trigger: null };
    const box = trigger.getBoundingClientRect();
    trigger.click();
    const menu = document.querySelector('#thread-tools .send-menu');
    return {
      label: trigger.textContent.trim(),
      height: Math.round(box.height),
      open: menu ? !menu.hidden : false,
      items: menu ? [...menu.querySelectorAll('.send-item')].map((b) => b.innerText.trim()) : [],
    };
  })()`);
  await shot('02-send-menu.png');
  await evaluate("document.body.click()");

  await shot('03-thread.png');

  /* ---- 5. project page (an empty project must still answer a click) ---- */
  report.project = await evaluate(`(async () => {
    const empty = document.querySelector('#tree .project-row.empty .project-main');
    const target = empty ?? document.querySelector('#tree .project-main');
    if (!target) return null;
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      title: document.querySelector('#thread-title')?.textContent,
      meta: document.querySelector('#thread-meta')?.textContent,
      body: document.querySelector('#transcript')?.innerText?.slice(0, 80),
    };
  })()`);

  /* ---- 6. order stability across a refresh ---- */
  report.orderBefore = await evaluate("[...document.querySelectorAll('#tree .project-name')].map((n) => n.textContent).join('|')");
  await evaluate("document.querySelector('#refresh').click()");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  report.orderAfter = await evaluate("[...document.querySelectorAll('#tree .project-name')].map((n) => n.textContent).join('|')");

  /* ---- 7. switch tool ---- */
  report.switched = await evaluate(`(() => {
    document.querySelector('#tool-switch').click();
    document.querySelectorAll('#tool-menu button')[1]?.click();
    return document.querySelector('#tool-label')?.textContent;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  report.switchedProjects = await evaluate("[...document.querySelectorAll('#tree .project-name')].map((n) => n.textContent)");
  await shot('04-claude.png');

  /* ---- 8. images in a transcript ---- */
  report.images = await evaluate(`(async () => {
    // The switch to the previous tool left the tree elsewhere; go back to Codex and
    // open the conversation that actually carries pictures.
    document.querySelector('#tool-switch').click();
    const codex = [...document.querySelectorAll('#tool-menu button')].find((b) => /Codex/.test(b.textContent || ''));
    if (codex) codex.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const input = document.querySelector('#search');
    input.value = '接入主流模型';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = [...document.querySelectorAll('#tree .chat-row')].find((r) => /接入主流模型/.test(r.textContent || ''));
    if (!row) return null;
    row.click();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const appeared = Date.now() + 20000;
    let imgs = [];
    while (Date.now() < appeared) {
      imgs = [...document.querySelectorAll('#transcript .msg-image img')];
      if (imgs.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Lazy images never fetch while off-screen.
    imgs.forEach((img) => {
      img.loading = 'eager';
    });
    imgs[0]?.scrollIntoView({ block: 'center' });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const first = imgs[0];
    return {
      count: imgs.length,
      complete: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      firstWidth: first ? first.naturalWidth : 0,
      firstSrc: first ? first.getAttribute('src') : null,
    };
  })()`);
  await evaluate(`(() => {
    const frame = document.querySelector('#transcript .msg-image');
    frame?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await shot('05-images.png');

  report.exceptions = browser
    .events()
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text)
    .slice(0, 5);
  report.consoleErrors = browser
    .events()
    .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
    .map((event) => event.params.args.map((arg: any) => arg.value ?? arg.description).join(' '))
    .slice(0, 5);

  fs.writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  chrome.kill('SIGTERM');
}
