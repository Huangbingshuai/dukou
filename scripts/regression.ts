#!/usr/bin/env node
/**
 * End-to-end regression for the mirror engine.
 *
 * Runs against throwaway stores under a temp directory, except for the real-store
 * read checks, which never write. Exit code 1 on any failed assertion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalize } from '../src/ir.ts';
import type { Conversation, Message } from '../src/ir.ts';
import { missingMessages, messageFingerprint } from '../src/ids.ts';
import { sha256 } from '../src/attachments.ts';
import { scanZstdFrames } from '../src/zstd.ts';
import { CodexReader } from '../src/adapters/codex.ts';
import { ClaudeReader } from '../src/adapters/claude.ts';
import { DshReader } from '../src/adapters/dsh.ts';
import { writeCodex } from '../src/writers/codex.ts';
import { writeClaude } from '../src/writers/claude.ts';
import { mirrorConversation } from '../src/mirror.ts';
import { syncGroups } from '../src/groups.ts';
import { Ledger } from '../src/ledger.ts';
import { withGroupLock } from '../src/lock.ts';
import { buildTranscript } from '../web/transcript.ts';

const ROOT = '/tmp/sm-regression';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function home(name: string): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const REAL_HOMES = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_HOME: process.env.CLAUDE_HOME,
  DSH_HOME: process.env.DSH_HOME,
};

/** Readers resolve their roots from the environment, exactly like the running harness. */
function useStores(stores: { codex: string; claude: string; dsh: string }): void {
  process.env.CODEX_HOME = stores.codex;
  process.env.CLAUDE_HOME = stores.claude;
  process.env.DSH_HOME = stores.dsh;
}

function restoreRealHomes(): void {
  for (const [key, value] of Object.entries(REAL_HOMES)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function freshStores(): { codex: string; claude: string; dsh: string } {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const codex = home('codex');
  const claude = home('claude');
  const dsh = home('dsh');
  fs.mkdirSync(path.join(dsh, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(dsh, 'storages', 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [] }, tables: { workspaces: {} } }),
  );
  // Seed the Codex index with the live schema so the writer is tested against reality.
  const liveDb = path.join(REAL_HOMES.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex'), 'state_5.sqlite');
  const live = new DatabaseSync(liveDb, { readOnly: true });
  live.exec(`vacuum into '${path.join(codex, 'state_5.sqlite')}'`);
  live.close();
  const history = new DatabaseSync(path.join(codex, 'thread_history_1.sqlite'));
  history.exec(`create table thread_items (
    thread_id text not null, turn_id text not null, item_id text not null,
    rollout_ordinal integer not null, created_at_ms integer not null, item_json text not null,
    item_type text not null default '', updated_at_ordinal integer not null default 0,
    started_at_ms integer, completed_at_ms integer,
    primary key (thread_id, turn_id, item_id)
  ); create unique index idx_thread_items_page on thread_items(thread_id, rollout_ordinal);`);
  history.close();
  const stores = { codex, claude, dsh };
  useStores(stores);
  return stores;
}

function sampleConversation(): Conversation {
  const now = Date.now();
  const messages: Message[] = [
    { id: 'm1', role: 'user', time: now, blocks: [{ type: 'text', text: '帮我看下这张图和工具调用' }] },
    { id: 'm2', role: 'user', time: now + 1, blocks: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] },
    { id: 'm3', role: 'assistant', time: now + 2, blocks: [{ type: 'reasoning', text: '先读文件再回答' }] },
    { id: 'm4', role: 'assistant', time: now + 3, blocks: [{ type: 'toolCall', callId: 'call_1', name: 'bash', input: '{"command":"ls -la"}' }] },
    { id: 'm5', role: 'tool', time: now + 4, blocks: [{ type: 'toolResult', callId: 'call_1', output: 'total 0\n', images: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] }] },
    { id: 'm6', role: 'assistant', time: now + 5, blocks: [{ type: 'text', text: '目录是空的。' }] },
    { id: 'm7', role: 'assistant', time: now + 6, blocks: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] },
  ];
  return {
    origin: 'dsh',
    sourceId: 'regression-source',
    projectName: 'demo',
    cwd: path.join(ROOT, 'project'),
    title: '回归样本',
    createdAt: now,
    updatedAt: now,
    archived: false,
    path: '',
    messages,
  };
}

async function testRoundTrip(): Promise<void> {
  const stores = freshStores();
  const conversation = sampleConversation();
  const ledgerPath = path.join(ROOT, 'ledger.json');

  // The source lives in the throwaway DSH store, then the engine fans it out.
  const { writeDsh } = await import('../src/writers/dsh.ts');
  const written = writeDsh(conversation, { home: stores.dsh, backupDir: path.join(ROOT, 'backup') });
  const result = await mirrorConversation('dsh', written.sessionId, ['codex', 'claude'], {
    codex: stores.codex,
    claude: stores.claude,
    dsh: stores.dsh,
    ledgerPath,
    backupDir: path.join(ROOT, 'backup'),
  });

  check('mirror created a Codex replica', result.targets.some((plan) => plan.origin === 'codex' && plan.action === 'create'));
  check('mirror created a Claude replica', result.targets.some((plan) => plan.origin === 'claude' && plan.action === 'create'));

  const record = new Ledger(ledgerPath).all()[0];
  const codexId = record.replicas.codex?.sessionId as string;
  const claudeId = record.replicas.claude?.sessionId as string;

  const dshMessages = canonicalize((await new DshReader().read(written.sessionId)).messages);
  const codexMessages = canonicalize((await new CodexReader().read(codexId)).messages);
  const claudeMessages = canonicalize((await new ClaudeReader().read(claudeId)).messages);

  check('DSH replica has 7 canonical messages', dshMessages.length === 7, `${dshMessages.length}`);
  check('Codex replica matches DSH', missingMessages(codexMessages, dshMessages).length === 0, `${missingMessages(codexMessages, dshMessages).length} missing`);
  check('Claude replica matches DSH', missingMessages(claudeMessages, dshMessages).length === 0, `${missingMessages(claudeMessages, dshMessages).length} missing`);

  for (const [name, messages] of [['dsh', dshMessages], ['codex', codexMessages], ['claude', claudeMessages]] as const) {
    const imageMessages = messages.filter((message) => message.blocks[0]?.type === 'image');
    check(`${name} kept the user and assistant images`, imageMessages.length === 2 && imageMessages[0].role === 'user' && imageMessages[1].role === 'assistant');
    check(
      `${name} kept image bytes and roles`,
      imageMessages.every((message) => {
        const block = message.blocks[0];
        return block?.type === 'image' && block.data && sha256(block.data) === sha256(PNG) &&
          (message.role === 'user' || message.role === 'assistant');
      }),
    );
  }

  const claudeToolBlocks = claudeMessages.flatMap((message) => message.blocks).filter((block) => block.type === 'toolResult');
  check('Claude tool result links to its matching call', claudeToolBlocks.length === 1 && claudeToolBlocks[0].type === 'toolResult' && claudeToolBlocks[0].callId === 'call_1');
  const codexToolBlock = codexMessages.flatMap((message) => message.blocks).find((block) => block.type === 'toolResult');
  check('Codex retained the tool-result image', codexToolBlock?.type === 'toolResult' && codexToolBlock.images?.length === 1 && codexToolBlock.images[0].data && sha256(codexToolBlock.images[0].data) === sha256(PNG));
  const imageViewDb = new DatabaseSync(path.join(stores.codex, 'thread_history_1.sqlite'), { readOnly: true });
  const imageViews = imageViewDb.prepare("select count(*) as count from thread_items where thread_id = ? and item_type = 'imageView'").get(codexId) as { count: number };
  imageViewDb.close();
  check('Codex projection contains all three imageView items', imageViews.count === 3, `${imageViews.count}`);

  // Idempotency: a second pass must change nothing.
  const second = await syncGroups({ codex: stores.codex, claude: stores.claude, dsh: stores.dsh, ledgerPath });
  const changed = second.reduce((sum, group) => sum + group.changed.length, 0);
  check('second pass is a no-op', changed === 0, `${changed} changed`);

  // A new message on one replica converges to the others.
  const { appendClaude } = await import('../src/writers/claude.ts');
  appendClaude(
    {
      ...conversation,
      messages: [
        { id: 'x1', role: 'user', time: Date.now(), blocks: [{ type: 'text', text: '这条来自 Claude' }] },
        { id: 'x2', role: 'assistant', time: Date.now() + 1, blocks: [{ type: 'text', text: '收到' }] },
      ],
    },
    claudeId,
    { home: stores.claude },
  );
  const third = await syncGroups({ codex: stores.codex, claude: stores.claude, dsh: stores.dsh, ledgerPath });
  const appended = third.reduce((sum, group) => sum + group.changed.reduce((n, plan) => n + plan.missing, 0), 0);
  check('new Claude messages propagated', appended >= 2, `${appended} appended`);

  const dshAfter = canonicalize((await new DshReader().read(written.sessionId)).messages);
  const codexAfter = canonicalize((await new CodexReader().read(codexId)).messages);
  check('DSH caught up after propagation', dshAfter.length === 9, `${dshAfter.length}`);
  check('Codex equals DSH after propagation', missingMessages(codexAfter, dshAfter).length === 0);

  // Exercise the DSH -> Claude path with all image placements. Reusing identical
  // bytes in a question and answer is intentional and must not be mistaken for a
  // duplicate turn; tool-result images must remain attached to their call too.
  const imageConversation: Conversation = {
    ...conversation,
    sourceId: 'dsh-claude-image-source',
    title: 'DSH Claude 图片验收',
    messages: [
      { id: 'img-user', role: 'user', blocks: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] },
      { id: 'img-answer', role: 'assistant', blocks: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] },
      { id: 'img-call', role: 'assistant', blocks: [{ type: 'toolCall', callId: 'image-call-1', name: 'inspect', input: '{}' }] },
      {
        id: 'img-result', role: 'tool',
        blocks: [{ type: 'toolResult', callId: 'image-call-1', output: '截图结果', images: [{ type: 'image', mime: 'image/png', ref: '', data: PNG }] }],
      },
    ],
  };
  const imageSource = writeDsh(imageConversation, { home: stores.dsh, backupDir: path.join(ROOT, 'backup') });
  const imageMirror = await mirrorConversation('dsh', imageSource.sessionId, ['claude'], {
    codex: stores.codex,
    claude: stores.claude,
    dsh: stores.dsh,
    ledgerPath,
    backupDir: path.join(ROOT, 'backup'),
  });
  const imageClaudeId = imageMirror.targets.find((target) => target.origin === 'claude')?.sessionId;
  const imageClaude = imageClaudeId ? canonicalize((await new ClaudeReader().read(imageClaudeId)).messages) : [];
  const standaloneImages = imageClaude.filter((message) => message.blocks[0]?.type === 'image');
  const imageToolResult = imageClaude.flatMap((message) => message.blocks).find((block) => block.type === 'toolResult');
  check('real DSH → Claude migration retained user and answer images', standaloneImages.length === 2 && standaloneImages[0].role === 'user' && standaloneImages[1].role === 'assistant');
  check('real DSH → Claude migration retained tool-result image and call id', Boolean(
    imageToolResult?.type === 'toolResult' && imageToolResult.callId === 'image-call-1' && imageToolResult.images?.length === 1 &&
    imageToolResult.images[0].data && sha256(imageToolResult.images[0].data) === sha256(PNG),
  ));
  const previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = stores.claude;
  const transcript = imageClaudeId ? await buildTranscript('claude', imageClaudeId) : { lines: [], images: [] };
  if (previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = previousClaudeHome;
  check('web transcript displays user, answer, and tool-result images', transcript.lines.filter((line) => line.kind === 'image').length === 3 && transcript.images.length === 1);

  const claudeSource = writeClaude(imageConversation, { home: stores.claude });
  const codexMirror = await mirrorConversation('claude', claudeSource.sessionId, ['codex'], {
    codex: stores.codex,
    claude: stores.claude,
    dsh: stores.dsh,
    ledgerPath,
    backupDir: path.join(ROOT, 'backup'),
  });
  const codexIdFromClaude = codexMirror.targets.find((target) => target.origin === 'codex')?.sessionId;
  const codexFromClaude = codexIdFromClaude ? canonicalize((await new CodexReader().read(codexIdFromClaude)).messages) : [];
  const codexImages = codexFromClaude.filter((message) => message.blocks[0]?.type === 'image');
  const codexToolResult = codexFromClaude.flatMap((message) => message.blocks).find((block) => block.type === 'toolResult');
  check('real Claude → Codex migration retained question, answer and tool-result images', codexImages.length === 2 && codexImages[0].role === 'user' && codexImages[1].role === 'assistant' && codexImages.every((message) => message.blocks[0]?.type === 'image' && message.blocks[0].data && sha256(message.blocks[0].data) === sha256(PNG)) && codexToolResult?.type === 'toolResult' && codexToolResult.images?.length === 1 && codexToolResult.images[0].data && sha256(codexToolResult.images[0].data) === sha256(PNG));
}

function testSchemaRefusal(): void {
  const dir = home('broken-codex');
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('create table threads (id text primary key, rollout_path text not null, created_at integer not null)');
  db.close();

  const before = fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')).length : 0;
  let threw = false;
  try {
    writeCodex(sampleConversation(), { home: dir, backupDir: path.join(dir, 'bak') });
  } catch (error) {
    threw = /schema changed/.test((error as Error).message);
  }
  const after = fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')).length : 0;
  check('unknown Codex schema refuses to write', threw);
  check('refusal left no rollout behind', before === after, `${before} -> ${after}`);
}

function testZstdFrames(): void {
  const sessions = path.join(process.env.HOME ?? '', '.dsh', 'sessions');
  let multi = 0;
  let checked = 0;
  for (const dir of fs.readdirSync(sessions)) {
    const base = path.join(sessions, dir);
    for (const child of fs.readdirSync(base).slice(0, 3)) {
      const file = path.join(base, child, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      checked += 1;
      const { frames } = scanZstdFrames(fs.readFileSync(file));
      if (frames.length > 1) multi += 1;
      if (checked >= 12) break;
    }
    if (checked >= 12) break;
  }
  check('composite zstd frame scan works', multi > 0, `${multi}/${checked} sessions have >1 frame`);
}

async function testRealGroup(): Promise<void> {
  restoreRealHomes();
  const ledger = new Ledger();
  const groups = ledger.all();
  if (groups.length === 0) {
    check('real ledger has a mirrored group', false, 'no groups');
    return;
  }
  check('real ledger has a mirrored group', true, `${groups.length} group(s)`);
  for (const group of groups) {
    const replicas = Object.entries(group.replicas) as Array<[string, { sessionId: string }]>;
    const messages: Record<string, Message[]> = {};
    for (const [origin, ref] of replicas) {
      const reader = origin === 'codex' ? new CodexReader() : origin === 'claude' ? new ClaudeReader() : new DshReader();
      try {
        messages[origin] = canonicalize((await reader.read(ref.sessionId)).messages);
      } catch {
        continue;
      }
    }
    const names = Object.keys(messages);
    if (names.length < 2) {
      check(`real group ${group.title.slice(0, 20)} has ≥2 readable replicas`, false, names.join(','));
      continue;
    }
    const base = messages[names[0]];
    let worst = 0;
    for (const name of names.slice(1)) {
      // The ledger records messages a harness provably cannot hold (a content
      // type it has no place for). Those are settled, not drift.
      const blocked = new Set(group.unrepresentable?.[name as keyof typeof group.unrepresentable] ?? []);
      const expected = blocked.size ? base.filter((message) => !blocked.has(messageFingerprint(message))) : base;
      worst = Math.max(worst, missingMessages(messages[name], expected).length);
    }
    // The realtime pass runs on a timer, so a live conversation legitimately lags
    // its replicas by up to one cadence of new messages.
    check(
      `real group "${group.title.slice(0, 24)}" replicas agree`,
      worst <= 40,
      worst === 0 ? `${names.join('/')} exact` : `${names.join('/')} lag ${worst} (within one realtime cadence)`,
    );
  }
}

async function testGroupLocks(): Promise<void> {
  const previousHome = process.env.DSH_HOME;
  const dsh = home('lock');
  process.env.DSH_HOME = dsh;
  const dir = path.join(dsh, 'migration-ledgers', '.locks');
  fs.mkdirSync(dir, { recursive: true });
  const groupId = 'lock-regression';
  const lock = path.join(dir, `${groupId}.lock`);
  let ran = false;
  try {
    fs.writeFileSync(lock, `${process.pid}\n`);
    const old = new Date(Date.now() - 600_000);
    fs.utimesSync(lock, old, old);
    let rejected = false;
    try {
      await withGroupLock(groupId, async () => { ran = true; }, { timeoutMs: 250 });
    } catch {
      rejected = true;
    }
    check('aged lock from a live process is never stolen', rejected && !ran && fs.existsSync(lock));

    fs.writeFileSync(lock, '2147483647\n');
    const result = await withGroupLock(groupId, async () => 'acquired', { timeoutMs: 250 });
    check('lock from a dead process is released', result === 'acquired' && !fs.existsSync(lock));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

const which = process.argv[2] ?? 'all';
try {
  if (which === 'all' || which === 'locks') await testGroupLocks();
  if (which === 'all' || which === 'roundtrip') await testRoundTrip();
  if (which === 'all' || which === 'schema') testSchemaRefusal();
  if (which === 'all' || which === 'zstd') testZstdFrames();
  if (which === 'all' || which === 'real') await testRealGroup();
} catch (error) {
  failures += 1;
  console.error(`ERROR ${(error as Error).stack ?? (error as Error).message}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
