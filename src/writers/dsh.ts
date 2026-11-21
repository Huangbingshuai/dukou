import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Block, Conversation, Message } from '../ir.ts';
import { canonicalize, deriveTitle } from '../ir.ts';
import { encodeDshCwd, safeBasename } from '../paths.ts';
import { compressFrame, decompressFrames } from '../zstd.ts';
import { byteLength, imageSize, sha256, writeDshImage } from '../attachments.ts';

/**
 * DSH is the strictest target. A session is a header line plus an event log with
 * dense `seq`, closed turn/step lifetimes, and `surfaceOp: 'append'` on every
 * surface event. The writer mirrors what DSH itself does for an imported session:
 *
 *   sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd   frames of JSONL
 *   storages/session_projcache/sessions/<uuid>.json               sidebar title/identity
 *   storages/workspace.json                                       workspace membership
 *
 * No `session/end-seed` is written: the ordinary resume path appends it the first
 * time the session is opened, exactly like DSH's own DeepSeek chat import.
 */

export interface DshWriteOptions {
  /** Overrides `~/.dsh`; tests use a throwaway root. */
  home?: string;
  /** Reuse an existing session id when updating a mirrored conversation. */
  sessionId?: string;
  backupDir?: string;
  /** Workspace to attach to; defaults to the one whose path matches `cwd`. */
  workspaceId?: string;
}

export interface DshWriteResult {
  sessionId: string;
  path: string;
  events: number;
  title: string;
  workspaceId?: string;
  backup?: string;
}

interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: 'append';
}

interface WorkspaceEntry {
  path?: string;
  title?: string;
  sessionIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceFile {
  unit?: { name: string; version: number };
  global?: Record<string, unknown> & { workspaceIds?: string[]; archivedSessionIds?: string[] };
  tables?: { workspaces?: Record<string, WorkspaceEntry> };
}

function dshRoot(options: DshWriteOptions): string {
  return options.home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh');
}

function backupFiles(root: string, backupDir: string, sessionId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(backupDir, `dsh-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const relative of ['storages/workspace.json', `storages/session_projcache/sessions/${sessionId}.json`]) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return dir;
}

function contentBlocks(blocks: Block[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text });
    else if (block.type === 'reasoning') out.push({ type: 'reasoning', text: block.text });
    else if (block.type === 'image') {
      if (!block.data) continue;
      const attachmentId = writeDshImage({ mime: block.mime, base64: block.data });
      const size = imageSize(block.data);
      out.push({
        type: 'image',
        attachment: {
          attachmentId,
          mediaType: block.mime,
          bytes: byteLength(block.data),
          ...(size ? { width: size.width, height: size.height } : {}),
        },
      });
    }
  }
  return out;
}

interface BuildOptions {
  /** 1-based turn number to start at, so appended events continue the log. */
  startTurn?: number;
  /** Emit the session/title event; append mode keeps the original title. */
  emitTitle?: boolean;
}

function buildEvents(conversation: Conversation, sessionId: string, options: BuildOptions = {}): DshEvent[] {
  const events: DshEvent[] = [];
  const messages = canonicalize(conversation.messages);
  const resultCallIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.blocks[0]?.type === 'toolResult')
      .map((message) => (message.blocks[0] as Extract<Block, { type: 'toolResult' }>).callId),
  );
  const start = conversation.createdAt || Date.now();
  const title = conversation.title || deriveTitle(conversation.messages);
  if (options.emitTitle !== false) {
    events.push({
      type: 'session/title',
      time: start,
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    });
  }

  let turn = options.startTurn ? options.startTurn - 1 : 0;
  let step = 0;
  let turnOpen = false;
  let stepOpen = false;
  let time = start;
  let messageIndex = 0;
  const pendingCalls: Array<{ sourceCallId: string; callId: string }> = [];

  const openTurn = (at: number) => {
    turn += 1;
    step = 1;
    turnOpen = true;
    stepOpen = true;
    events.push({ type: 'turn/start', time: at, data: { turn } });
    events.push({ type: 'step/start', time: at, data: { turn, step } });
  };
  const closeTurn = (at: number) => {
    if (!turnOpen) return;
    events.push({ type: 'step/end', time: at, data: { turn, step } });
    events.push({ type: 'turn/end', time: at, data: { turn, reason: { kind: 'completed' } } });
    turnOpen = false;
    stepOpen = false;
  };

  for (const message of messages) {
    time = message.time ?? start + messageIndex * 1000;
    messageIndex += 1;
    const block = message.blocks[0];
    if (!block) continue;

    if (message.role === 'user') {
      closeTurn(time);
      openTurn(time);
      events.push({
        type: 'user/message',
        time,
        data: {
          id: message.id,
          role: 'user',
          content: contentBlocks(message.blocks),
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      });
      continue;
    }

    if (!turnOpen) openTurn(time);

    if (message.role === 'assistant' && (block.type === 'text' || block.type === 'reasoning' || block.type === 'image')) {
      events.push({
        type: 'assistant/message',
        time,
        data: {
          turn,
          step,
          message: {
            id: message.id,
            role: 'assistant',
            content: contentBlocks(message.blocks),
            source: { kind: 'model', provider: 'session-mirror', model: 'mirrored' },
          },
          stream: [],
        },
        surfaceOp: 'append',
      });
      continue;
    }

    if (message.role === 'assistant' && block.type === 'toolCall') {
      const callId = block.callId || `mirror-call-${messageIndex}`;
      // A call without an exactly matching result would remain unresolved at
      // step/end, which the native DSH parser rejects. Keep its full input in
      // the transcript as text instead of opening an invalid lifecycle.
      if (!resultCallIds.has(callId)) {
        events.push({
          type: 'assistant/message',
          time,
          data: {
            turn,
            step,
            message: {
              id: message.id || `mirror-call-text-${messageIndex}`,
              role: 'assistant',
              content: [{ type: 'text', text: `调用工具：${block.name}\n${block.input}` }],
              source: { kind: 'model', provider: 'session-mirror', model: 'mirrored' },
            },
            stream: [],
          },
          surfaceOp: 'append',
        });
        continue;
      }
      pendingCalls.push({ sourceCallId: block.callId, callId });
      // DSH requires the tool call to be advertised in an assistant message
      // before the first-class tool/call event. The call event alone is
      // readable by our importer but rejected by the official session parser.
      events.push({
        type: 'assistant/message',
        time,
        data: {
          turn,
          step,
          message: {
            id: message.id || `mirror-advertisement-${messageIndex}`,
            role: 'assistant',
            content: [{ type: 'tool-call', id: callId, name: block.name, arguments: block.input }],
            source: { kind: 'model', provider: 'session-mirror', model: 'mirrored' },
          },
          stream: [],
        },
        surfaceOp: 'append',
      });
      events.push({
        type: 'tool/call',
        time,
        data: { turn, step, callId, name: block.name, arguments: block.input },
      });
      continue;
    }

    if (message.role === 'tool' && block.type === 'toolResult') {
      const matchingIndex = pendingCalls.findIndex(
        (pending) => pending.sourceCallId === block.callId || pending.callId === block.callId,
      );
      // Do not guess FIFO here. Codex can emit generic/reused call IDs, and a
      // FIFO match can bind an output to an unrelated DSH lifecycle. Preserve
      // unmatched output as transcript text below.
      const pendingIndex = matchingIndex;
      const [pending] = pendingIndex >= 0 ? pendingCalls.splice(pendingIndex, 1) : [];
      if (!pending) {
        // Some Codex rollouts contain repeated/generic call_id values on
        // function_call_output rows, with no corresponding function_call row.
        // DSH rejects a tool/result without an advertised call lifecycle. Keep
        // the output verbatim as an assistant transcript message instead.
        events.push({
          type: 'assistant/message',
          time,
          data: {
            turn,
            step,
            message: {
              id: typeof message.id === 'string' && message.id.length > 0 ? message.id : crypto.randomUUID(),
              role: 'assistant',
              content: [{ type: 'text', text: block.output }],
              source: { kind: 'model', provider: 'session-mirror', model: 'mirrored' },
            },
            stream: [],
          },
          surfaceOp: 'append',
        });
        continue;
      }
      const callId = pending.callId;
      events.push({
        type: 'tool/result',
        time,
        data: {
          turn,
          step,
          message: {
            // v4 requires every message, tool results included, to carry a
            // non-empty string id; the app refuses the whole log without it.
            id: typeof message.id === 'string' && message.id.length > 0 ? message.id : crypto.randomUUID(),
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            content: [
              ...(block.output ? [{ type: 'text', text: block.output }] : []),
              ...contentBlocks(block.images ?? []),
            ],
            ...(block.isError ? { isError: true } : {}),
          },
        },
        surfaceOp: 'append',
      });
    }
  }

  closeTurn(time);
  return events;
}

/** Ensures the workspace registry holds this session under the matching project. */
function attachWorkspace(
  root: string,
  sessionId: string,
  cwd: string,
  requested?: string,
): string | undefined {
  const file = path.join(root, 'storages', 'workspace.json');
  if (!fs.existsSync(file)) return undefined;
  let data: WorkspaceFile;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceFile;
  } catch {
    throw new Error(`workspace registry is unreadable: ${file}`);
  }
  const workspaces = (data.tables ??= {}).workspaces ??= {};
  let workspaceId =
    requested ??
    Object.entries(workspaces).find(([, entry]) => entry.path === cwd)?.[0] ??
    Object.entries(workspaces).find(([, entry]) => entry.sessionIds?.includes(sessionId))?.[0];

  if (!workspaceId) {
    workspaceId = crypto.randomUUID();
    workspaces[workspaceId] = {
      path: cwd,
      title: safeBasename(cwd),
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const global = (data.global ??= {});
    global.workspaceIds ??= [];
    global.workspaceIds.push(workspaceId);
  }

  const entry = workspaces[workspaceId];
  entry.sessionIds ??= [];
  if (!entry.sessionIds.includes(sessionId)) entry.sessionIds.push(sessionId);
  entry.updatedAt = new Date().toISOString();

  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return workspaceId;
}

/** Writes the conversation as a DSH-native session the sidebar can open and continue. */
export function writeDsh(conversation: Conversation, options: DshWriteOptions = {}): DshWriteResult {
  const root = dshRoot(options);
  const sessionId = options.sessionId ?? `session-${crypto.randomUUID()}`;
  if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error(`invalid dsh session id: ${sessionId}`);

  const dir = path.join(root, 'sessions', encodeDshCwd(conversation.cwd), sessionId);
  if (fs.existsSync(dir)) throw new Error(`dsh session already exists: ${dir}; refusing to overwrite`);

  const backup = backupFiles(root, options.backupDir ?? path.join(root, 'migration-backups'), sessionId);
  const events = buildEvents(conversation, sessionId);
  const createdAt = conversation.createdAt || Date.now();
  const title = conversation.title || deriveTitle(conversation.messages);

  // Header frame, then one frame per turn, mirroring DSH's own durable batches.
  const frames: string[] = [];
  frames.push(
    JSON.stringify({
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt,
      cwd: conversation.cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    }),
  );
  let buffer: string[] = [];
  let seq = 0;
  for (const event of events) {
    buffer.push(JSON.stringify({ ...event, seq: seq++ }));
    if (event.type === 'turn/end') {
      frames.push(buffer.join('\n'));
      buffer = [];
    }
  }
  if (buffer.length > 0) frames.push(buffer.join('\n'));

  const bytes = Buffer.concat(frames.map((frame) => compressFrame(`${frame}\n`)));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const tempDir = `${dir}.tmp-${process.pid}`;
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'session.v4.jsonl.zstd'), bytes);
  fs.renameSync(tempDir, dir);

  // Projection cache: what the sidebar reads for title and identity.
  const cacheFile = path.join(root, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const cache = {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt, cwd: conversation.cwd, isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: 1, seq: 0, val: title } },
    },
  };
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');

  const workspaceId = attachWorkspace(root, sessionId, conversation.cwd, options.workspaceId);

  return {
    sessionId,
    path: path.join(dir, 'session.v4.jsonl.zstd'),
    events: events.length,
    title,
    workspaceId,
    backup,
  };
}

/** Events already present in a session log, plus the coordinates to continue from. */
interface LogState {
  nextSeq: number;
  lastTurn: number;
  turnOpen: boolean;
  stepOpen: boolean;
  lastStep: number;
}

export function readLogState(file: string): LogState {
  const bytes = fs.readFileSync(file);
  const text = decompressFrames(file, bytes);
  let nextSeq = 0;
  let lastTurn = 0;
  let turnOpen = false;
  let stepOpen = false;
  let lastStep = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: DshEvent;
    try {
      event = JSON.parse(line) as DshEvent;
    } catch {
      continue;
    }
    if (typeof event.seq === 'number') nextSeq = Math.max(nextSeq, event.seq + 1);
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      lastTurn = Number(data.turn ?? lastTurn);
      turnOpen = true;
      stepOpen = false;
    } else if (event.type === 'turn/end') {
      turnOpen = false;
      stepOpen = false;
    } else if (event.type === 'step/start') {
      stepOpen = true;
      lastStep = Number(data.step ?? 1);
    } else if (event.type === 'step/end') {
      stepOpen = false;
    }
  }
  return { nextSeq, lastTurn, turnOpen, stepOpen, lastStep };
}

/**
 * Appends a continuation to an existing DSH session by writing one more frame.
 *
 * DSH reads the log frame by frame, so closing an open turn/step and continuing
 * the sequence in a fresh checksummed frame is exactly how its own writer grows
 * a session.
 */
export function appendDsh(
  conversation: Conversation,
  sessionId: string,
  options: DshWriteOptions = {},
): { path: string; events: number; from: number } {
  const root = dshRoot(options);
  const dir = path.join(root, 'sessions', encodeDshCwd(conversation.cwd), sessionId);
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(file)) throw new Error(`dsh session not found: ${file}`);

  const state = readLogState(file);
  const prefix: DshEvent[] = [];
  if (state.turnOpen) {
    if (state.stepOpen) prefix.push({ type: 'step/end', data: { turn: state.lastTurn, step: state.lastStep } });
    prefix.push({ type: 'turn/end', data: { turn: state.lastTurn, reason: { kind: 'interrupted' } } });
  }

  const events = buildEvents(conversation, sessionId, { startTurn: state.lastTurn + 1, emitTitle: false });
  const all = [...prefix, ...events];
  let seq = state.nextSeq;
  const lines = all.map((event) => JSON.stringify({ ...event, seq: seq++ })).join('\n');
  fs.appendFileSync(file, compressFrame(`${lines}\n`));
  return { path: file, events: all.length, from: state.nextSeq };
}
