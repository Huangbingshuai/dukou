import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Block, Conversation, Message } from '../ir.ts';
import { canonicalize, deriveTitle } from '../ir.ts';

type Row = Record<string, unknown>;

export interface ZcodeWriteOptions {
  /** Overrides ~/.zcode; tests use an isolated home. */
  home?: string;
  /** Reuse an existing session id when appending to a mirrored conversation. */
  sessionId?: string;
  /** Where pre-write SQLite snapshots go. */
  backupDir?: string;
}

export interface ZcodeWriteResult {
  sessionId: string;
  path: string;
  rows: number;
  title: string;
  backup?: string;
}

function zcodeHome(options: ZcodeWriteOptions): string {
  return options.home ?? process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode');
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function assertSchema(db: DatabaseSync, table: string, required: string[]): void {
  const found = columns(db, table);
  if (required.some((name) => !found.has(name))) {
    throw new Error(`Unsupported ZCode database schema: ${table} table is missing required columns`);
  }
}

function snapshot(db: DatabaseSync, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, db.serialize(), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function backup(backupDir: string, sessionDb: DatabaseSync, tasksDb?: DatabaseSync): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupDir, `zcode-${stamp}`);
  snapshot(sessionDb, path.join(dir, 'cli', 'db', 'db.sqlite'));
  if (tasksDb) snapshot(tasksDb, path.join(dir, 'v2', 'tasks-index.sqlite'));
  return dir;
}

function imageExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg': case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/svg+xml': return '.svg';
    default: return '.png';
  }
}

function artifactFor(home: string, sessionId: string, block: Extract<Block, { type: 'image' }>, createdFiles: string[]): { url: string; filename: string } | undefined {
  if (!block.data) return undefined;
  const bytes = Buffer.from(block.data.replace(/^data:[^,]*;base64,/, ''), 'base64');
  if (!bytes.length) return undefined;
  const artifactId = `tool-result-${crypto.randomUUID()}`;
  const name = `dukou-${artifactId}.txt`;
  const dir = path.join(home, 'cli', 'artifacts', sessionId);
  const target = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  const dataUrl = `data:${block.mime};base64,${bytes.toString('base64')}`;
  fs.writeFileSync(temp, dataUrl, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, target); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
  createdFiles.push(target);
  return { url: `zcode-artifact://${encodeURIComponent(sessionId)}/${encodeURIComponent(artifactId)}`, filename: `dukou-image${imageExtension(block.mime)}` };
}

function filePart(block: Extract<Block, { type: 'image' }>, home: string, sessionId: string, createdFiles: string[]): Row | undefined {
  const asset = artifactFor(home, sessionId, block, createdFiles);
  return asset ? { type: 'file', mime: block.mime, url: asset.url, filename: asset.filename } : undefined;
}

function contentParts(block: Block, home: string, sessionId: string, time: number, createdFiles: string[]): Row[] {
  switch (block.type) {
    case 'text': return [{ type: 'text', text: block.text }];
    case 'reasoning': return [{ type: 'reasoning', text: block.text }];
    case 'image': {
      const part = filePart(block, home, sessionId, createdFiles);
      return part ? [part] : [];
    }
    case 'toolCall':
      return [{ type: 'tool', callID: block.callId, tool: block.name, state: { status: 'completed', input: safeJson(block.input), time: { start: time, end: time } } }];
    case 'toolResult': {
      const output: Row[] = [];
      if (block.output) output.push({ type: 'text', text: block.output });
      for (const image of block.images ?? []) {
        const part = filePart(image, home, sessionId, createdFiles);
        if (part) output.push(part);
      }
      return [{ type: 'tool_result', callID: block.callId, output, ...(block.isError ? { isError: true } : {}) }];
    }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

function nativeMessageData(role: string, cwd: string, time: number, parentUserMessageId: string | null): Row {
  if (role === 'user') {
    return {
      role,
      time: { created: time },
      agent: 'build',
      model: { providerID: 'glm', modelID: 'glm-5.3' },
      semantics: { transcriptVisibility: 'visible', kind: 'user_prompt', origin: 'dukou', author: 'real_user' },
    };
  }
  return {
    role,
    time: { created: time, completed: time },
    parentID: parentUserMessageId,
    modelID: 'glm-5.3',
    providerID: 'glm',
    mode: 'build',
    agent: 'zcode-agent',
    path: { cwd, root: cwd },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    semantics: { transcriptVisibility: 'visible', origin: 'dukou' },
  };
}

function nativePartData(part: Row, id: string, sessionId: string, messageId: string): Row {
  const data: Row = { ...part, id, sessionID: sessionId, messageID: messageId };
  const state = part.state && typeof part.state === 'object' ? part.state as Row : undefined;
  if (state && Array.isArray(state.attachments)) {
    data.state = {
      ...state,
      attachments: (state.attachments as Row[]).map((attachment) => ({
        ...attachment,
        id: `prt_${crypto.randomUUID()}`,
        sessionID: sessionId,
        messageID: messageId,
      })),
    };
  }
  return data;
}

function primaryParts(messages: Message[], home: string, sessionId: string, createdFiles: string[]): Array<{ message: Message; parts: Row[]; time: number }> {
  const canonical = canonicalize(messages);
  const results = new Map<string, Extract<Block, { type: 'toolResult' }>>();
  for (const message of canonical) {
    const block = message.blocks[0];
    if (block?.type === 'toolResult' && block.callId) results.set(block.callId, block);
  }
  const consumedResults = new Set<string>();
  const out: Array<{ message: Message; parts: Row[]; time: number }> = [];
  canonical.forEach((message, index) => {
    const block = message.blocks[0];
    if (!block) return;
    if (block.type === 'toolResult' && consumedResults.has(block.callId)) return;
    const time = Math.max(message.time ?? 0, index === 0 ? 0 : (out.at(-1)?.time ?? 0));
    let parts: Row[];
    if (block.type === 'toolCall') {
      const result = results.get(block.callId);
      const call = contentParts(block, home, sessionId, time, createdFiles)[0];
      const attachments: Row[] = [];
      for (const image of result?.images ?? []) {
        const file = filePart(image, home, sessionId, createdFiles);
        if (file) attachments.push(file);
      }
      if (call) {
        const state = call.state as Row;
        parts = [{
          ...call,
          state: result?.isError
            ? { status: 'error', input: state.input, error: result.output || 'Imported tool error', metadata: {}, time: state.time }
            : { status: 'completed', input: state.input, output: result?.output ?? '', title: block.name, metadata: {}, time: state.time, ...(attachments.length ? { attachments } : {}) },
        }];
      } else parts = [];
      if (result) consumedResults.add(result.callId);
    } else {
      parts = contentParts(block, home, sessionId, time, createdFiles);
    }
    if (parts.length) out.push({ message, parts, time });
  });
  return out;
}

function openDatabase(file: string): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`ZCode database not found: ${file}; open ZCode once to initialize its local stores`);
  const db = new DatabaseSync(file);
  db.exec('pragma busy_timeout = 5000');
  return db;
}

function openTaskIndex(home: string): DatabaseSync | undefined {
  const file = path.join(home, 'v2', 'tasks-index.sqlite');
  if (!fs.existsSync(file)) return undefined;
  const db = openDatabase(file);
  assertSchema(db, 'tasks', ['workspace_key', 'workspace_path', 'task_id', 'title', 'provider', 'mode', 'created_at', 'updated_at']);
  return db;
}

function projectForWorkspace(db: DatabaseSync, cwd: string): { id: string; root: string } {
  assertSchema(db, 'projects', ['project_id', 'deleted']);
  assertSchema(db, 'project_roots', ['project_id', 'root_path', 'is_primary']);
  const roots = db.prepare(`select p.project_id, r.root_path from projects p join project_roots r on r.project_id = p.project_id where coalesce(p.deleted, 0) = 0`).all() as Array<{ project_id: string; root_path: string }>;
  const match = roots
    .filter((row) => cwd === row.root_path || cwd.startsWith(`${row.root_path.replace(/[\\/]+$/, '')}${path.sep}`))
    .sort((a, b) => b.root_path.length - a.root_path.length)[0];
  if (!match) throw new Error(`No trusted ZCode project contains ${cwd}; create or trust that project in ZCode before migrating`);
  return { id: match.project_id, root: match.root_path };
}

function insertTaskIndex(db: DatabaseSync, sessionId: string, title: string, cwd: string, projectId: string, rootPath: string, createdAt: number, updatedAt: number, messages: Message[]): void {
  const searchable = messages.flatMap((message) => message.blocks.flatMap((block) => block.type === 'text' ? [block.text] : [])).join('\n');
  const names = ['workspace_key', 'workspace_path', 'task_id', 'title', 'task_status', 'provider', 'mode', 'created_at', 'updated_at', 'archived', 'deleted', 'meta_json', 'searchable_text', 'cli_title', 'cli_created_at', 'cli_updated_at', 'project_id', 'root_path'];
  const present = columns(db, 'tasks');
  const selected = names.filter((name) => present.has(name));
  const values: Row = {
    workspace_key: cwd,
    workspace_path: cwd,
    task_id: sessionId,
    title,
    task_status: 'completed',
    provider: 'glm',
    mode: 'build',
    created_at: createdAt,
    updated_at: updatedAt,
    archived: 0,
    deleted: 0,
    meta_json: JSON.stringify({ importedBy: 'dukou' }),
    searchable_text: `${title}\n${searchable}`,
    cli_title: title,
    cli_created_at: createdAt,
    cli_updated_at: updatedAt,
    project_id: projectId,
    root_path: rootPath,
  };
  const sql = `insert into tasks (${selected.join(',')}) values (${selected.map(() => '?').join(',')}) on conflict(workspace_key,task_id) do update set title=excluded.title, updated_at=excluded.updated_at, searchable_text=excluded.searchable_text, cli_title=excluded.cli_title, cli_updated_at=excluded.cli_updated_at`;
  // Older task-index snapshots may not have the modern composite primary key.
  try { db.prepare(sql).run(...selected.map((name) => values[name])); }
  catch (error) {
    if (!String(error).includes('ON CONFLICT clause does not match')) throw error;
    db.prepare(`insert or replace into tasks (${selected.join(',')}) values (${selected.map(() => '?').join(',')})`).run(...selected.map((name) => values[name]));
  }
}

/** Writes a resumable ZCode session to its native SQLite store and desktop task index. */
export function writeZcode(conversation: Conversation, options: ZcodeWriteOptions = {}): ZcodeWriteResult {
  const home = zcodeHome(options);
  const sessionId = options.sessionId ?? `sess_${crypto.randomUUID()}`;
  const dbFile = path.join(home, 'cli', 'db', 'db.sqlite');
  const db = openDatabase(dbFile);
  let tasksDb: DatabaseSync | undefined;
  const createdArtifacts: string[] = [];
  let backupPath: string | undefined;
  const title = conversation.title || deriveTitle(conversation.messages);
  let messages: ReturnType<typeof primaryParts> = [];
  let project: { id: string; root: string } | undefined;
  const now = Date.now();
  try {
    assertSchema(db, 'session', ['id', 'project_id', 'slug', 'directory', 'title', 'version', 'time_created', 'time_updated', 'task_type', 'title_source']);
    assertSchema(db, 'message', ['id', 'session_id', 'time_created', 'time_updated', 'data', 'sequence']);
    assertSchema(db, 'part', ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data', 'sequence']);
    if (db.prepare('select 1 from session where id = ?').get(sessionId)) throw new Error(`ZCode session already exists: ${sessionId}`);
    const backupDir = options.backupDir ?? path.join(home, 'dukou-backups');
    // Read-only snapshot validation happens before the first session write.
    tasksDb = openTaskIndex(home);
    if (!tasksDb) throw new Error(`ZCode task index not found: ${path.join(home, 'v2', 'tasks-index.sqlite')}; open ZCode to initialize desktop stores`);
    project = projectForWorkspace(tasksDb, conversation.cwd);
    backupPath = backup(backupDir, db, tasksDb);
    messages = primaryParts(conversation.messages, home, sessionId, createdArtifacts);

    db.exec('begin immediate');
    tasksDb?.exec('begin immediate');
    try {
      const slug = conversation.cwd.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
      let firstWrittenMessageId: string | null = null;
      let parentUserMessageId: string | null = null;
      db.prepare(`insert into session (id, project_id, workspace_id, slug, directory, path, title, version, time_created, time_updated, task_type, title_source, title_message_id, time_title_updated)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sessionId, project.id, null, slug, conversation.cwd, conversation.cwd, title, '0.17.1', conversation.createdAt || now, conversation.updatedAt || now, 'interactive', 'first_input', null, now);

      const insertMessage = db.prepare('insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)');
      const insertPart = db.prepare('insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?, ?)');
      let msgSequence = 0;
      for (const entry of messages) {
        const messageId = `msg_${crypto.randomUUID()}`;
        if (!firstWrittenMessageId && entry.message.role === 'user') firstWrittenMessageId = messageId;
        const time = entry.time || now + msgSequence;
        const role = entry.message.role === 'tool' ? 'assistant' : entry.message.role;
        if (role === 'user') parentUserMessageId = messageId;
        insertMessage.run(messageId, sessionId, time, time, JSON.stringify(nativeMessageData(role, conversation.cwd, time, parentUserMessageId)), msgSequence++);
        entry.parts.forEach((part, sequence) => {
          const id = `prt_${crypto.randomUUID()}`;
          insertPart.run(id, messageId, sessionId, time + sequence, time + sequence, JSON.stringify(nativePartData(part, id, sessionId, messageId)), sequence);
        });
      }
      if (firstWrittenMessageId) db.prepare('update session set title_message_id = ? where id = ?').run(firstWrittenMessageId, sessionId);
      insertTaskIndex(tasksDb, sessionId, title, conversation.cwd, project.id, project.root, conversation.createdAt || now, conversation.updatedAt || now, conversation.messages);
      db.prepare('update session set time_updated = ? where id = ?').run(conversation.updatedAt || now, sessionId);
      tasksDb?.prepare('update tasks set updated_at = ? where task_id = ? and workspace_key = ?').run(conversation.updatedAt || now, sessionId, conversation.cwd);
      tasksDb?.exec('commit');
      db.exec('commit');
    } catch (error) {
      try { tasksDb?.exec('rollback'); } catch { /* no open transaction */ }
      try { db.exec('rollback'); } catch { /* no open transaction */ }
      throw error;
    }
    return { sessionId, path: dbFile, rows: messages.length, title, backup: backupPath };
  } catch (error) {
    for (const file of createdArtifacts) fs.rmSync(file, { force: true });
    throw error;
  } finally {
    tasksDb?.close();
    db.close();
  }
}

/** Append ordered missing messages to an existing mirrored session. */
export function appendZcode(conversation: Conversation, sessionId: string, options: ZcodeWriteOptions = {}): { path: string; rows: number } {
  const home = zcodeHome(options);
  const dbFile = path.join(home, 'cli', 'db', 'db.sqlite');
  const db = openDatabase(dbFile);
  let tasksDb: DatabaseSync | undefined;
  const createdArtifacts: string[] = [];
  let entries: ReturnType<typeof primaryParts> = [];
  const now = Date.now();
  try {
    assertSchema(db, 'session', ['id', 'time_updated']);
    const row = db.prepare('select id from session where id = ? and time_deleted is null').get(sessionId);
    if (!row) throw new Error(`zcode session not found: ${sessionId}`);
    tasksDb = fs.existsSync(path.join(home, 'v2', 'tasks-index.sqlite')) ? openDatabase(path.join(home, 'v2', 'tasks-index.sqlite')) : undefined;
    backup(options.backupDir ?? path.join(home, 'dukou-backups'), db, tasksDb);
    entries = primaryParts(conversation.messages, home, sessionId, createdArtifacts);
    db.exec('begin immediate');
    tasksDb?.exec('begin immediate');
    let written = 0;
    try {
      const next = db.prepare('select coalesce(max(sequence), -1) + 1 as n from message where session_id = ?').get(sessionId) as { n: number };
      let msgSequence = next.n;
      let lastTime = 0;
      const priorUser = db.prepare("select id from message where session_id = ? and json_extract(data, '$.role') = 'user' order by sequence desc limit 1").get(sessionId) as { id?: string } | undefined;
      let parentUserMessageId = priorUser?.id ?? null;
      const insertMessage = db.prepare('insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)');
      const insertPart = db.prepare('insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?, ?)');
      for (const entry of entries) {
        const messageId = `msg_${crypto.randomUUID()}`;
        const time = Math.max(entry.time || now + written, lastTime);
        lastTime = time;
        const role = entry.message.role === 'tool' ? 'assistant' : entry.message.role;
        if (role === 'user') parentUserMessageId = messageId;
        insertMessage.run(messageId, sessionId, time, time, JSON.stringify(nativeMessageData(role, conversation.cwd, time, parentUserMessageId)), msgSequence++);
        entry.parts.forEach((part, sequence) => {
          const partId = `prt_${crypto.randomUUID()}`;
          insertPart.run(partId, messageId, sessionId, time + sequence, time + sequence, JSON.stringify(nativePartData(part, partId, sessionId, messageId)), sequence);
        });
        written += 1;
      }
      db.prepare('update session set time_updated = ? where id = ?').run(now, sessionId);
      const appendedText = conversation.messages.flatMap((message) => message.blocks.flatMap((block) => block.type === 'text' ? [block.text] : [])).join('\n');
      tasksDb?.prepare('update tasks set updated_at = ?, cli_updated_at = ?, searchable_text = searchable_text || ? where task_id = ?').run(now, now, `\n${appendedText}`, sessionId);
      tasksDb?.exec('commit');
      db.exec('commit');
    } catch (error) {
      try { tasksDb?.exec('rollback'); } catch { /* no open transaction */ }
      try { db.exec('rollback'); } catch { /* no open transaction */ }
      throw error;
    }
    return { path: dbFile, rows: written };
  } catch (error) {
    for (const file of createdArtifacts) fs.rmSync(file, { force: true });
    throw error;
  } finally {
    // Images created for a failed append must not accumulate without database rows.
    // If the write succeeded, the new artifact paths are all referenced by parts.
    tasksDb?.close();
    db.close();
  }
}
