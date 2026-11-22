#!/usr/bin/env node
import type { Conversation, ConversationMeta, Origin, Reader } from './ir.ts';
import { summarizeBlocks } from './ir.ts';
import { readerFor as makeReader } from './readers.ts';
import { writeClaude } from './writers/claude.ts';
import { writeCodex } from './writers/codex.ts';
import { writeDsh } from './writers/dsh.ts';
import { mirrorConversation } from './mirror.ts';
import { canonicalize } from './ir.ts';
import { Ledger } from './ledger.ts';
import type { Origin as MirrorOrigin } from './ir.ts';
import { harnessOf, HARNESS_IDS } from './registry.ts';

const READERS: Record<Origin, () => Reader> = {
  codex: () => makeReader('codex'), claude: () => makeReader('claude'), dsh: () => makeReader('dsh'),
  kimi: () => makeReader('kimi'), zcode: () => makeReader('zcode'),
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readerFor(name: string | undefined): Reader {
  if (!name || !(name in READERS)) {
    throw new Error(`--from must be one of: ${Object.keys(READERS).join(', ')}`);
  }
  return READERS[name as Origin]();
}

function fmtTime(ms: number): string {
  if (!ms) return '---------- --:--';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

async function commandList(): Promise<void> {
  const reader = readerFor(arg('from'));
  const limit = Number(arg('limit') ?? 20);
  const rows = (await reader.list()).slice(0, limit);
  console.log(`${reader.origin}: showing ${rows.length}`);
  for (const row of rows) {
    console.log(
      [
        fmtTime(row.updatedAt),
        row.archived ? 'archived' : 'active  ',
        clip(row.projectName, 22).padEnd(22),
        clip(row.title, 48).padEnd(48),
        row.sourceId.slice(0, 14),
        `${String(row.cwd).split('/').slice(-2).join('/')}`,
      ].join('  '),
    );
  }
}

async function commandDump(): Promise<void> {
  const reader = readerFor(arg('from'));
  const id = arg('id');
  if (!id) throw new Error('--id is required');
  const conversation: Conversation = await reader.read(id);
  printConversation(conversation, Number(arg('limit') ?? 200));
}

function printConversation(conversation: Conversation, limit: number): void {
  console.log(`# ${conversation.title}`);
  console.log(
    `origin=${conversation.origin} id=${conversation.sourceId} project=${conversation.projectName} cwd=${conversation.cwd}`,
  );
  console.log(
    `created=${fmtTime(conversation.createdAt)} updated=${fmtTime(conversation.updatedAt)} messages=${conversation.messages.length}`,
  );
  console.log('');
  for (const message of conversation.messages.slice(0, limit)) {
    const summary = summarizeBlocks(message.blocks);
    const text = message.blocks
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'reasoning') return `[thinking] ${block.text}`;
        if (block.type === 'toolCall') return `[call ${block.name}] ${clip(block.input, 120)}`;
        if (block.type === 'toolResult') return `[result] ${clip(block.output, 120)}`;
        return `[image ${block.mime}]`;
      })
      .join('\n');
    console.log(`--- ${message.role} (${summary})`);
    console.log(text.split('\n').slice(0, 12).map((line) => `    ${clip(line, 160)}`).join('\n'));
  }
  if (conversation.messages.length > limit) {
    console.log(`... ${conversation.messages.length - limit} more messages`);
  }
}

async function commandExport(): Promise<void> {
  const reader = readerFor(arg('from'));
  const id = arg('id');
  if (!id) throw new Error('--id is required');
  const target = arg('to');
  if (!target || !harnessOf(target)?.canWrite) throw new Error(`--to must be a writable tool: ${HARNESS_IDS.filter((id) => harnessOf(id)?.canWrite).join(', ')}`);
  const conversation = await reader.read(id);
  if (target === 'claude') {
    const result = writeClaude(conversation, { home: arg('home') });
    console.log(`wrote ${result.rows} rows -> ${result.path}`);
    console.log(`title: ${result.title}`);
    console.log(`resume: claude --resume ${result.sessionId}`);
    return;
  }
  if (target === 'codex') {
    const result = writeCodex(conversation, { home: arg('home'), backupDir: arg('backup') });
    console.log(`wrote ${result.rows} rows -> ${result.path}`);
    console.log(`title: ${result.title}`);
    if (result.backup) console.log(`backup: ${result.backup}`);
    console.log(`resume: (cd ${conversation.cwd} && codex resume ${result.threadId})`);
    return;
  }
  if (target === 'dsh') {
    const result = writeDsh(conversation, { home: arg('home'), backupDir: arg('backup') });
    console.log(`wrote ${result.events} events -> ${result.path}`);
    console.log(`title: ${result.title}  workspace: ${result.workspaceId ?? '-'}`);
    if (result.backup) console.log(`backup: ${result.backup}`);
    console.log(`resume: dsh session ${result.sessionId}`);
    return;
  }
  throw new Error('--to must be one of: claude, codex, dsh');
}

async function commandSync(): Promise<void> {
  const from = arg('from') as MirrorOrigin | undefined;
  const id = arg('id');
  if (!from || !id) throw new Error('--from and --id are required');
  const targets = (arg('to') ?? HARNESS_IDS.filter((id) => harnessOf(id)?.canWrite).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) as MirrorOrigin[];
  const result = await mirrorConversation(from, id, targets, {
    codex: arg('codex-home'),
    claude: arg('claude-home'),
    dsh: arg('dsh-home'),
    kimi: arg('kimi-home'),
    zcode: arg('zcode-home'),
    backupDir: arg('backup'),
    dryRun: flag('dry-run'),
    ledgerPath: arg('ledger'),
  });
  console.log(`group ${result.groupId}`);
  console.log(`source ${result.source.origin}/${result.source.sessionId} · ${result.canonicalMessages} messages · ${result.title}`);
  for (const plan of result.targets) {
    const detail = plan.error ? `error: ${plan.error}` : `${plan.missing} missing · ${plan.sessionId ?? ''}`;
    console.log(`  ${plan.origin.padEnd(7)} ${plan.action.padEnd(6)} ${detail}`);
  }
}

/** Human-readable health report: stores, groups, and how far each replica lags. */
async function commandDoctor(): Promise<void> {
  const ledger = new Ledger();
  const groups = ledger.all();
  console.log(`ledger: ${ledger.file}`);
  console.log(`groups: ${groups.length}`);
  for (const group of groups) {
    const rows: string[] = [];
    let leader = { origin: '', count: 0 };
    const counts: Record<string, number> = {};
    for (const origin of HARNESS_IDS) {
      const ref = group.replicas[origin];
      if (!ref) {
        rows.push(`${origin} —`);
        continue;
      }
      try {
        const conversation = await READERS[origin]().read(ref.sessionId);
        const count = canonicalize(conversation.messages).length;
        counts[origin] = count;
        if (count > leader.count) leader = { origin, count };
        rows.push(`${origin} ${count}`);
      } catch {
        rows.push(`${origin} ✗`);
      }
    }
    const lag = Object.entries(counts).map(([origin, count]) => `${leader.count - count}@${origin}`).join(' ');
    console.log(`  ${group.title.slice(0, 32).padEnd(32)} ${rows.join(' · ')}  lag ${lag}`);
  }
}

async function commandStats(): Promise<void> {
  for (const [name, make] of Object.entries(READERS)) {
    const started = Date.now();
    let rows: ConversationMeta[];
    try { rows = await make().list(); }
    catch (error) {
      console.log(`${name.padEnd(7)} unavailable  ${(error as Error).message}`);
      continue;
    }
    const total = rows.reduce((sum, row: ConversationMeta) => sum + 1, 0);
    console.log(
      `${name.padEnd(7)} ${String(total).padStart(4)} sessions  ${String(
        rows.reduce((sum, row) => sum + row.title.length, 0),
      ).padStart(0)} title chars  ${Date.now() - started}ms`,
    );
  }
}

const command = process.argv[2];
try {
  if (command === 'list') await commandList();
  else if (command === 'dump') await commandDump();
  else if (command === 'export') await commandExport();
  else if (command === 'sync') await commandSync();
  else if (command === 'doctor') await commandDoctor();
  else if (command === 'stats') await commandStats();
  else {
    console.log('usage: cli.ts <list|dump|export|sync|doctor|stats> [--from codex|claude|dsh|kimi|zcode] [--id <id>] [--limit n]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  if (flag('trace')) console.error(error);
  process.exitCode = 1;
}
