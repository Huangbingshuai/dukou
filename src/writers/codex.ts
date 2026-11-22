import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Block, Conversation } from '../ir.ts';
import { canonicalize, deriveTitle } from '../ir.ts';
import { uuidV5 } from '../ids.ts';

/**
 * Codex needs two writes, not three:
 *
 *  1. an append-only rollout under `sessions/YYYY/MM/DD/rollout-*.jsonl`
 *  2. one row in `state_5.sqlite` `threads`
 *
 * `thread_history_projection_state` is deliberately left empty: Codex folds a
 * rollout with no projection row from byte 0 the first time it opens the thread.
 * That is what keeps the write fast and avoids hand-synthesizing `thread_items`.
 *
 * Safety: probe the live schema first, back the store up, write the rollout to a
 * temporary file, insert the index row in a transaction, and delete the rollout
 * again if the insert fails. A schema we do not recognize aborts before any byte
 * is written.
 */

const REQUIRED_COLUMNS = [
  'id',
  'rollout_path',
  'created_at',
  'updated_at',
  'source',
  'model_provider',
  'cwd',
  'title',
  'sandbox_policy',
  'approval_mode',
] as const;

export interface CodexWriteOptions {
  /** Overrides `~/.codex`; tests use a throwaway store. */
  home?: string;
  /** Reuse an existing thread id when updating a mirrored conversation. */
  threadId?: string;
  /** Where to put the pre-write database backup. */
  backupDir?: string;
  /** Permit replacing an existing thread row with the same id. */
  replace?: boolean;
}

export interface CodexWriteResult {
  threadId: string;
  path: string;
  rows: number;
  title: string;
  backup?: string;
}

interface RolloutRow {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function codexHome(options: CodexWriteOptions): string {
  return options.home ?? process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`select name from pragma_table_info(?)`).all(table) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Copies the SQLite store (plus its WAL sidecars) before a mutation.
 *
 * A realtime append happens every few seconds, so an unconditional copy would
 * fill the disk with near-identical snapshots. `reuseWithinMs` keeps a snapshot
 * fresh enough for rollback without piling them up; thread creation always takes
 * a new one.
 */
function backupStore(home: string, backupDir: string, reuseWithinMs = 0): string {
  if (reuseWithinMs > 0 && fs.existsSync(backupDir)) {
    const recent = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith('codex-'))
      .map((name) => path.join(backupDir, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'state_5.sqlite')))
      .sort()
      .at(-1);
    if (recent) {
      const age = Date.now() - fs.statSync(recent).mtimeMs;
      if (age < reuseWithinMs) return recent;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(backupDir, `codex-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = path.join(home, `state_5.sqlite${suffix}`);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, `state_5.sqlite${suffix}`));
  }
  return dir;
}

/**
 * Codex groups threads by `projects` + `project_roots`, but it does not attach a
 * thread to a project on its own: most threads carry no `project_id` until the
 * user files them. Mirroring therefore follows the source's *project name and
 * folder* as a pair — it reuses a project only when both match, and never
 * hijacks an unrelated project that happens to own the same directory.
 */
export function ensureProject(db: DatabaseSync, cwd: string, name: string): string | undefined {
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!tables.has('projects') || !tables.has('project_roots')) return undefined;

  const same = db
    .prepare(
      `select p.id from projects p join project_roots r on r.project_id = p.id
        where r.path = ? and p.name = ? limit 1`,
    )
    .get(cwd, name) as { id: string } | undefined;
  if (same?.id) return same.id;

  const id = uuidV5(`codex-project:${name}:${cwd}`);
  const existing = db.prepare('select id from projects where id = ?').get(id) as { id: string } | undefined;
  if (existing?.id) return existing.id;

  const max = db.prepare('select coalesce(max(position), 0) as position from projects').get() as { position: number };
  const now = Date.now();
  db.prepare(
    'insert into projects (id, name, metadata, position, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?, ?)',
  ).run(id, name, '{}', max.position + 1, now, now);
  db.prepare('insert into project_roots (project_id, position, path) values (?, ?, ?)').run(id, 0, cwd);
  return id;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The desktop app keeps its own project registry and its own thread→project
 * filing, separate from what `state_5.sqlite` uses at runtime:
 *
 *   .codex-global-state.json
 *     local-projects: { <localId>: { id, name, rootPaths, ... } }
 *     project-order:  [ <localId>, ... ]
 *     app-server-project-id-by-legacy-project-id-by-host:
 *                     { "local:<home>": { <localId>: <state_5 project id> } }
 *     thread-project-assignments: { <threadId>: { projectKind: 'local', projectId } }
 *
 * A thread whose project id is not bridged there has no place in the sidebar, so
 * it stays invisible even though the rollout and the threads row are correct.
 */
interface DesktopProject {
  id: string;
  name?: string;
  rootPaths?: string[];
  createdAt?: number;
  updatedAt?: number;
}

function desktopStateFile(home: string): string {
  return path.join(home, '.codex-global-state.json');
}

/**
 * The runtime project id this desktop project already bridges to, if any. When it
 * exists, reusing it keeps previously filed threads in the same sidebar group
 * instead of creating a second project with the same name.
 */
export function desktopLegacyProjectId(home: string, cwd: string, name: string): string | undefined {
  const file = desktopStateFile(home);
  if (!fs.existsSync(file)) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    const projects = (state['local-projects'] ?? {}) as Record<string, DesktopProject>;
    const mapping =
      state['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${home}`] ?? {};
    const project = Object.values(projects).find(
      (entry) => entry.name === name && (entry.rootPaths ?? []).includes(cwd),
    );
    return project ? (mapping[project.id] as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeDesktopState(home: string, file: string, state: Record<string, any>, withBackup: boolean): void {
  if (withBackup) {
    try {
      const dir = path.join(home, 'mirror-backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(
        file,
        path.join(dir, `codex-global-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      );
    } catch {
      // a missing backup directory must not block the write
    }
  }
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // the app treats .bak as best-effort too
  }
}

/**
 * Files a freshly written thread into the desktop app's own project registry.
 *
 * The app keeps `local-projects` / `thread-project-assignments` in memory and
 * rewrites the file whenever its own state changes, so a single write can be
 * clobbered within seconds. The assignment is therefore re-applied a couple of
 * times (each attempt re-reads the file, so the app's edits are preserved).
 */
export function registerDesktopThread(
  home: string,
  cwd: string,
  name: string,
  threadId: string,
  legacyProjectId: string | null,
): void {
  const file = desktopStateFile(home);
  if (!fs.existsSync(file)) return;
  const wanted = name || path.basename(cwd);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let state: Record<string, any>;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    } catch {
      return;
    }
    const projects = (state['local-projects'] ??= {}) as Record<string, DesktopProject>;
    const order = (state['project-order'] ??= []) as string[];
    const byHost = (state['app-server-project-id-by-legacy-project-id-by-host'] ??= {}) as Record<
      string,
      Record<string, string>
    >;
    const mapping = (byHost[`local:${home}`] ??= {});
    const assignments = (state['thread-project-assignments'] ??= {}) as Record<
      string,
      { projectKind: string; projectId: string }
    >;

    const byNameAndRoot = Object.values(projects).find(
      (project) => project.name === wanted && (project.rootPaths ?? []).includes(cwd),
    );
    const byLegacyId = legacyProjectId
      ? Object.values(projects).find((project) => mapping[project.id] === legacyProjectId)
      : undefined;
    const now = Date.now();
    const project: DesktopProject =
      byNameAndRoot ??
      byLegacyId ??
      ({ id: crypto.randomUUID(), name: wanted, rootPaths: [cwd], createdAt: now, updatedAt: now } as DesktopProject);

    if (!projects[project.id]) projects[project.id] = project;
    if (legacyProjectId) mapping[project.id] = legacyProjectId;
    if (!order.includes(project.id)) order.push(project.id);
    assignments[threadId] = { projectKind: 'local', projectId: project.id };
    const projectless = state['projectless-thread-ids'];
    if (Array.isArray(projectless)) {
      const at = projectless.indexOf(threadId);
      if (at !== -1) projectless.splice(at, 1);
    }

    writeDesktopState(home, file, state, attempt === 0);
    try {
      const check = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
      if (check['thread-project-assignments']?.[threadId]) return;
    } catch {
      // fall through and retry
    }
    sleepSync(200);
  }
}

function messageContent(block: Block, role: 'user' | 'assistant'): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
      return role === 'user'
        ? { type: 'input_text', text: block.text }
        : { type: 'output_text', text: block.text };
    case 'reasoning':
      return undefined;
    case 'image':
      return block.data
        ? { type: role === 'user' ? 'input_image' : 'output_image', image_url: `data:${block.mime};base64,${block.data}`, detail: 'high' }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Builds a rollout that mirrors the shape Codex itself writes for a cross-tool
 * import: `task_started` / `item_completed` + `response_item` / `task_complete`
 * per turn.
 */
interface RolloutSeed {
  /** continue the thread's own numbering so appends never reuse an item/turn id */
  item?: number;
  turn?: number;
}

function buildRollout(
  conversation: Conversation,
  threadId: string,
  includeMeta = true,
  seed: RolloutSeed = {},
  home?: string,
): RolloutRow[] {
  const rows: RolloutRow[] = [];
  const push = (time: number, type: string, payload: Record<string, unknown>) =>
    rows.push({ timestamp: isoAt(time), type, payload });

  const start = conversation.createdAt || Date.now();
  if (includeMeta) push(start, 'session_meta', {
    session_id: threadId,
    id: threadId,
    timestamp: isoAt(start),
    cwd: conversation.cwd,
    originator: 'session-mirror',
    cli_version: '0.169.1',
    source: 'vscode',
    model_provider: 'openai',
    history_mode: 'paginated',
    base_instructions: { text: '(conversation mirrored from another harness)' },
  });

  let turn = seed.turn ?? 0;
  let turnOpen = false;
  let item = seed.item ?? 0;
  let turnStart = start;
  let lastAgentText: string | null = null;

  const openTurn = (time: number) => {
    turn += 1;
    turnStart = time;
    turnOpen = true;
    push(time, 'event_msg', {
      type: 'task_started',
      turn_id: `mirror-turn-${turn}`,
      started_at: Math.floor(time / 1000),
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    });
  };

  const closeTurn = (time: number) => {
    if (!turnOpen) return;
    push(time, 'event_msg', {
      type: 'task_complete',
      turn_id: `mirror-turn-${turn}`,
      last_agent_message: lastAgentText,
      started_at: Math.floor(turnStart / 1000),
      completed_at: Math.floor(time / 1000),
    });
    turnOpen = false;
  };

  const summariseTools = process.env.SESSION_MIRROR_CODEX_TOOLS === 'summary';
  // One summary per burst of tool-only turns, not one per call.
  let pendingTools = 0;
  const pendingNames = new Set<string>();
  let pendingAt = 0;
  const flushToolSummary = () => {
    if (pendingTools === 0) return;
    const names = [...pendingNames].slice(0, 3).join('、');
    const summary = `（执行了 ${pendingTools} 个操作${names ? `：${names}` : ''}）`;
    item += 1;
    push(pendingAt, 'event_msg', {
      type: 'item_completed',
      thread_id: threadId,
      turn_id: `mirror-turn-${turn}`,
      item: { type: 'AgentMessage', id: `item-${item}`, content: [{ type: 'Text', text: summary }] },
      completed_at_ms: pendingAt,
    });
    push(pendingAt, 'response_item', {
      type: 'message',
      id: `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: summary }],
    });
    lastAgentText = summary;
    pendingTools = 0;
    pendingNames.clear();
  };

  const messages = canonicalize(conversation.messages);
  const finalTextIndices = new Set<number>();
  let foundFinalText = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') foundFinalText = false;
    else if (!foundFinalText && message.role === 'assistant' && message.blocks.some((block) => block.type === 'text' && block.text.trim())) {
      finalTextIndices.add(index);
      foundFinalText = true;
    }
  }
  messages.forEach((message, index) => {
    const time = message.time ?? start + index * 1000;
    if (summariseTools && message.role === 'assistant') {
      const calls = message.blocks.filter((block) => block.type === 'toolCall');
      const onlyToolTraffic = message.blocks.every((block) => block.type === 'toolCall' || block.type === 'toolResult');
      if (onlyToolTraffic) {
        pendingTools += calls.length;
        for (const call of calls) pendingNames.add(call.name);
        pendingAt = time;
        return;
      }
    }
    if (message.role === 'user') flushToolSummary();
    // Tool-only turns are summarized for readability, but the summary must stay
    // before the next user-facing assistant response. If it is deferred until
    // the following user message, Codex treats that summary as the turn's final
    // AgentMessage and can hide the actual answer in the conversation view.
    if (
      summariseTools &&
      message.role === 'assistant' &&
      message.blocks.some((block) => block.type === 'text' || block.type === 'image')
    ) {
      flushToolSummary();
    }
    if (message.role === 'user') {
      closeTurn(time);
      openTurn(time);
    } else if (!turnOpen) {
      openTurn(time);
    }

    // A message can mix text and tool traffic: DSH delivers the assistant text in
    // `assistant/message` and each call in its own `tool/call` event, so every
    // block is mapped independently instead of returning after the first kind.
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] = [];

    for (const block of message.blocks) {
      if (block.type === 'text' || block.type === 'image') {
        const mapped = messageContent(block, role);
        if (mapped) content.push(mapped);
      } else if (block.type === 'reasoning') {
        push(time, 'response_item', {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: block.text }],
          content: [],
        });
      } else if (block.type === 'toolCall') {
        item += 1;
        if (summariseTools) continue;
        push(time, 'response_item', {
          type: 'function_call',
          name: block.name,
          arguments: block.input,
          call_id: block.callId || `call-${item}`,
        });
      } else if (block.type === 'toolResult') {
        if (summariseTools) continue;
        const output = block.images?.some((image) => image.data)
          ? [
              ...(block.output ? [{ type: 'input_text', text: block.output }] : []),
              ...block.images.filter((image) => image.data).map((image) => ({
                type: 'input_image',
                image_url: `data:${image.mime};base64,${image.data}`,
                detail: 'high',
              })),
            ]
          : block.output;
        push(time, 'response_item', {
          type: 'function_call_output',
          call_id: block.callId || `call-${item}`,
          output,
        });
      }
    }

    if (content.length > 0 && (message.role === 'user' || message.role === 'assistant')) {
      item += 1;
      const text = content
        .filter((entry) => typeof entry.text === 'string')
        .map((entry) => String(entry.text))
        .join('\n');
      push(time, 'event_msg', {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: `mirror-turn-${turn}`,
        item:
          message.role === 'user'
            ? {
                type: 'UserMessage',
                id: `item-${item}`,
                client_id: crypto.randomUUID(),
                // Codex's own event items use `text`, not the API's `input_text`;
                // the app's projection drops user messages otherwise.
                // Codex's event items carry the text only; the image bytes live in
                // the response_item (that is what its own rollouts look like).
                // The app paints the event item's content, so it has to carry the
                // images too — a pointer line would just show up as text.
                content: (() => {
                  // Images never survive Codex's fold; the event item carries text
                  // only, plus a placeholder so a picture-only turn still shows up.
                  const mapped = content
                    .filter((entry) => entry.type === 'input_text')
                    .map((entry) => ({ type: 'text', text: entry.text, text_elements: [] }));
                  return mapped;
                })(),
              }
            : { type: 'AgentMessage', id: `item-${item}`, content: [{ type: 'Text', text }], phase: finalTextIndices.has(index) ? 'final_answer' : 'commentary' },
        completed_at_ms: time,
      });
      push(time, 'response_item', {
        type: 'message',
        id: `msg_${crypto.randomUUID()}`,
        role: message.role,
        content,
        ...(message.role === 'assistant' ? { phase: finalTextIndices.has(index) ? 'final_answer' : 'commentary' } : {}),
      });
      if (message.role === 'assistant' && text) lastAgentText = text;
    }
  });

  flushToolSummary();
  const lastTime = conversation.messages.at(-1)?.time ?? start + conversation.messages.length * 1000;
  closeTurn(lastTime);
  return rows;
}

/** Writes the conversation as a Codex-native, resumable thread. */
export function writeCodex(conversation: Conversation, options: CodexWriteOptions = {}): CodexWriteResult {
  const home = codexHome(options);
  const dbPath = path.join(home, 'state_5.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`codex store not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  try {
    const columns = tableColumns(db, 'threads');
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`codex schema changed: threads is missing ${missing.join(', ')}; refusing to write`);
    }

    const threadId = options.threadId ?? uuidV5(`${conversation.origin}:${conversation.sourceId}:${Date.now()}`);
    const existing = db.prepare('select id from threads where id = ?').get(threadId);
    if (existing && !options.replace) {
      throw new Error(`codex thread ${threadId} already exists; refusing to overwrite`);
    }

    const backup = backupStore(home, options.backupDir ?? path.join(home, 'mirror-backups'));
    const rollout = buildRollout(conversation, threadId, true, {}, home);
    const body = rollout
      .map((row, ordinal) => JSON.stringify({ ...row, ordinal }))
      .join('\n')
      .concat('\n');

    const created = conversation.createdAt || Date.now();
    const date = new Date(created);
    const day = path.join(
      home,
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    );
    fs.mkdirSync(day, { recursive: true });
    const stamp = isoAt(created).replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(day, `rollout-${stamp}-${threadId}.jsonl`);
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, body, 'utf8');

    const firstUser = conversation.messages.find((message) => message.role === 'user');
    const firstUserText =
      firstUser?.blocks
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .trim() ?? '';
    const title = conversation.title || deriveTitle(conversation.messages);

    const values: Record<string, unknown> = {
      id: threadId,
      project_id: null,
      rollout_path: file,
      created_at: Math.floor(created / 1000),
      updated_at: Math.floor(Date.now() / 1000),
      source: 'vscode',
      model_provider: 'openai',
      cwd: conversation.cwd,
      title,
      sandbox_policy: JSON.stringify({ type: 'read-only' }),
      approval_mode: 'on-request',
      cli_version: '0.169.1',
      first_user_message: firstUserText.slice(0, 4000),
      preview: firstUserText.slice(0, 200),
      has_user_event: 1,
      archived: 0,
      archived_at: null,
      memory_mode: 'enabled',
      history_mode: 'paginated',
      recency_at: Math.floor(Date.now() / 1000),
      recency_at_ms: Date.now(),
      created_at_ms: created,
      updated_at_ms: Date.now(),
      originator: 'session-mirror',
      thread_source: 'user',
      model: null,
      reasoning_effort: null,
    };
    db.exec('begin immediate');
    try {
      // Projects are created inside the same transaction: a failed insert must not
      // leave an empty project folder behind.
      const projectName = conversation.projectName || path.basename(conversation.cwd);
      try {
        const bridged = desktopLegacyProjectId(home, conversation.cwd, projectName);
        const known = bridged ? db.prepare('select id from projects where id = ?').get(bridged) : undefined;
        values.project_id =
          (known ? bridged : ensureProject(db, conversation.cwd, projectName)) ?? null;
      } catch {
        values.project_id = null;
      }
      const present = Object.keys(values).filter((column) => columns.has(column));
      const sql = `insert into threads (${present.join(', ')}) values (${present.map(() => '?').join(', ')})`;
      fs.renameSync(temp, file);
      db.prepare(sql).run(...present.map((column) => values[column] as never));
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      fs.rmSync(temp, { force: true });
      fs.rmSync(file, { force: true });
      throw error;
    }

    // The rollout and the runtime row are enough for `codex resume`; the desktop
    // sidebar additionally needs the project bridge above, or the thread has no
    // place to appear. Never let that filing take the write down with it.
    try {
      registerDesktopThread(
        home,
        conversation.cwd,
        conversation.projectName || path.basename(conversation.cwd),
        threadId,
        typeof values.project_id === 'string' ? values.project_id : null,
      );
    } catch {
      // the store itself is already correct
    }

    try {
      attachImageViewRows(home, threadId, file);
    } catch {
      // The rollout remains usable when Codex's optional image projection is absent.
    }

    return { threadId, path: file, rows: rollout.length, title, backup };
  } finally {
    db.close();
  }
}

/**
 * Appends a continuation to an existing Codex thread.
 *
 * A rollout is an append-only log and Codex folds everything past its recorded
 * `next_rollout_byte_offset` on the next open, so appending rows and bumping the
 * thread's `updated_at` is enough; no projection work is needed here either.
 */
export function appendCodex(
  conversation: Conversation,
  threadId: string,
  options: CodexWriteOptions = {},
): { path: string; rows: number } {
  const home = codexHome(options);
  const dbPath = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const columns = tableColumns(db, 'threads');
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`codex schema changed: threads is missing ${missing.join(', ')}; refusing to write`);
    }
    const row = db.prepare('select rollout_path from threads where id = ?').get(threadId) as
      | { rollout_path: string }
      | undefined;
    if (!row) throw new Error(`codex thread not found: ${threadId}`);
    const file = row.rollout_path;
    if (!fs.existsSync(file)) throw new Error(`codex rollout missing: ${file}`);

    // Appends only bump timestamps; one snapshot per ten minutes is plenty.
    backupStore(home, options.backupDir ?? path.join(home, 'mirror-backups'), 10 * 60 * 1000);

    const existing = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let ordinal = 0;
    for (const line of existing) {
      try {
        ordinal = Math.max(ordinal, Number((JSON.parse(line) as { ordinal?: number }).ordinal ?? 0));
      } catch {
        continue;
      }
    }
    // The delta carries only the new messages, so its own ids would restart at
    // item-1 / mirror-turn-1 and collide with the rollout's existing ones. Continue
    // from the highest ids already on disk instead.
    let seedItem = 0;
    let seedTurn = 0;
    for (const line of existing) {
      const text = line;
      const itemMatch = /"id":"item-(\d+)"/.exec(text);
      if (itemMatch) seedItem = Math.max(seedItem, Number(itemMatch[1]));
      const turnMatch = /"turn_id":"mirror-turn-(\d+)"/.exec(text);
      if (turnMatch) seedTurn = Math.max(seedTurn, Number(turnMatch[1]));
    }
    const rows = buildRollout(conversation, threadId, false, { item: seedItem, turn: seedTurn }, home);
    if (rows.length === 0) return { path: file, rows: 0 };
    const body = rows
      .map((entry) => JSON.stringify({ ...entry, ordinal: ++ordinal }))
      .join('\n')
      .concat('\n');
    fs.appendFileSync(file, body, 'utf8');
    try {
      attachImageViewRows(home, threadId, file);
    } catch {
      // Keep the durable append if the image projection cannot be refreshed.
    }

    const values: Record<string, unknown> = {
      updated_at: Math.floor(Date.now() / 1000),
      updated_at_ms: Date.now(),
      recency_at: Math.floor(Date.now() / 1000),
      recency_at_ms: Date.now(),
    };
    const present = Object.keys(values).filter((column) => columns.has(column));
    db.prepare(`update threads set ${present.map((column) => `${column} = ?`).join(', ')} where id = ?`).run(
      ...present.map((column) => values[column] as never),
      threadId as never,
    );
    return { path: file, rows: rows.length };
  } finally {
    db.close();
  }
}

/**
 * Rewrites an existing thread's rollout from scratch.
 *
 * Needed when a rollout accumulated rows the app cannot fold: earlier appends
 * restarted the item/turn numbering, so the projection deduplicated messages and
 * the thread looked truncated. The projection state is dropped as well, which
 * makes Codex fold the whole rollout again the next time the thread is opened.
 */
export function rewriteCodex(
  conversation: Conversation,
  threadId: string,
  options: CodexWriteOptions = {},
): { path: string; rows: number } {
  const home = codexHome(options);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  try {
    const row = db.prepare('select rollout_path from threads where id = ?').get(threadId) as
      | { rollout_path: string }
      | undefined;
    if (!row) throw new Error(`codex thread not found: ${threadId}`);
    if (!fs.existsSync(row.rollout_path)) throw new Error(`codex rollout missing: ${row.rollout_path}`);

    backupStore(home, options.backupDir ?? path.join(home, 'mirror-backups'));
    const rows = buildRollout(conversation, threadId, true, {}, home);
    const body = rows.map((entry, index) => JSON.stringify({ ...entry, ordinal: index + 1 })).join('\n').concat('\n');
    const temp = `${row.rollout_path}.tmp-${process.pid}`;
    fs.writeFileSync(temp, body, 'utf8');
    fs.renameSync(temp, row.rollout_path);

    db.prepare('update threads set updated_at = ?, updated_at_ms = ?, recency_at = ?, recency_at_ms = ? where id = ?').run(
      Math.floor(Date.now() / 1000) as never,
      Date.now() as never,
      Math.floor(Date.now() / 1000) as never,
      Date.now() as never,
      threadId as never,
    );

    // Drop what the app remembered about this thread; it re-folds from byte 0.
    const historyPath = path.join(home, 'thread_history_1.sqlite');
    if (fs.existsSync(historyPath)) {
      const history = new DatabaseSync(historyPath);
      try {
        for (const table of ['thread_items', 'thread_turns', 'thread_history_projection_state']) {
          try {
            history.prepare(`delete from ${table} where thread_id = ?`).run(threadId as never);
          } catch {
            // a store without that table is fine
          }
        }
      } finally {
        history.close();
      }
    }
    // Re-create the picture items the fold will not produce on its own.
    try {
      attachImageViewRows(home, threadId, row.rollout_path);
    } catch {
      // pictures are a nicety; the text rebuild must not fail because of them
    }
    return { path: row.rollout_path, rows: rows.length };
  } finally {
    db.close();
  }
}

/** Minimal read of one thread row, for repair tooling. */
export function codexThreadInfo(
  threadId: string,
  options: CodexWriteOptions = {},
): { id: string; title: string; originator: string; rollout_path: string } | undefined {
  const home = codexHome(options);
  const dbPath = path.join(home, 'state_5.sqlite');
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('select id, title, originator, rollout_path from threads where id = ?')
      .get(threadId) as { id: string; title: string; originator: string; rollout_path: string } | undefined;
  } finally {
    db.close();
  }
}

/**
 * Codex's fold drops images written by anything but itself, so a repaired thread
 * loses its pictures entirely. Its own picture items are `imageView` rows pointing
 * at a file; adding those rows for the thread's images is what makes a mirrored
 * screenshot visible (as the "viewed N images" block) at all.
 */
function attachImageViewRows(home: string, threadId: string, rolloutPath: string): number {
  const historyPath = path.join(home, 'thread_history_1.sqlite');
  if (!fs.existsSync(historyPath)) return 0;
  const rows = fs
    .readFileSync(rolloutPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const turns: Array<{ turnId: string; itemType: string; ordinal: number }> = [];
  for (const row of rows) {
    const payload = row.payload ?? {};
    if (row.type === 'event_msg' && payload.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(payload.item?.type)) {
      turns.push({ turnId: String(payload.turn_id), itemType: payload.item.type, ordinal: Number(row.ordinal ?? 0) });
    }
  }
  if (turns.length === 0) return 0;

  const db = new DatabaseSync(historyPath);
  try {
    db.prepare("delete from thread_items where thread_id = ? and item_type = 'imageView'").run(threadId as never);
    const insert = db.prepare(
      `insert into thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, started_at_ms, completed_at_ms)
       values (?, ?, ?, ?, ?, ?, 'imageView', ?, ?, ?)`,
    );
    let count = 0;
    for (const row of rows) {
      const payload = row.payload ?? {};
      if (row.type !== 'response_item') continue;
      const isToolOutput = payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
      if (!isToolOutput && (payload.type !== 'message' || !['user', 'assistant'].includes(payload.role))) continue;
      const itemType = isToolOutput ? undefined : payload.role === 'user' ? 'UserMessage' : 'AgentMessage';
      const imageEntries = isToolOutput
        ? (Array.isArray(payload.output) ? payload.output : []).filter((entry: any) => entry.type === 'input_image')
        : (payload.content ?? []).filter((entry: any) => entry.type === 'input_image' || entry.type === 'output_image');
      for (const image of imageEntries) {
        const url = String(image.image_url ?? '');
        const bytes = Buffer.from(url.split(',')[1] ?? '', 'base64');
        if (bytes.length === 0) continue;
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const ext = (url.match(/^data:image\/([a-z]+)/)?.[1] ?? 'png').replace('jpeg', 'jpg');
        const dir = path.join(home, 'attachments', threadId, hash.slice(0, 16));
        const imageFile = path.join(dir, `image-${count + 1}.${ext}`);
        if (!fs.existsSync(imageFile)) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(imageFile, bytes);
        }
        const ordinal = Number(row.ordinal ?? 0);
        const anchor = [...turns].reverse().find((turn) => (!itemType || turn.itemType === itemType) && turn.ordinal <= ordinal);
        if (!anchor) continue;
        const id = `exec-${crypto.randomUUID()}`;
        let at = anchor.ordinal + 1;
        const now = Date.now();
        while (db.prepare('select 1 from thread_items where thread_id = ? and rollout_ordinal = ?').get(threadId, at)) at += 1;
        insert.run(threadId as never, anchor.turnId as never, id as never, at as never, now as never,
          JSON.stringify({ type: 'imageView', id, path: imageFile }) as never, at as never, now as never, now as never);
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
