import fs from 'node:fs';
import path from 'node:path';

import type { Block, Conversation, ConversationMeta, Message, Reader } from '../ir.ts';
import { deriveTitle } from '../ir.ts';
import { encodeDshCwd, safeBasename } from '../paths.ts';
import zlib from 'node:zlib';
import { decompressFrames, scanZstdFrames } from '../zstd.ts';
import { readDshImage } from '../attachments.ts';

/**
 * DSH keeps a session in three places:
 *
 *   sessions/<encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd   the event log
 *   storages/session_projcache/sessions/session-<uuid>.json       what the sidebar lists
 *   storages/workspace.json                                       workspace membership
 *
 * The projection cache is the authoritative title/identity for listing (it is
 * exactly what DSH itself reads), so `list()` never decompresses a session.
 */

interface ProjCacheRow {
  identity?: { createdAt?: number; cwd?: string; formatVersion?: number };
  rows?: {
    title?: { val?: string | null };
    /** how many human messages the session has seen; 0 for a never-used shell */
    titleInput?: { val?: { count?: number } };
    /** closed turns; 0 while a brand-new conversation has not produced a reply */
    sessionStats?: { val?: { turns?: number } };
  };
}

interface ProjCacheFile {
  version?: number;
  record?: ProjCacheRow;
}

interface WorkspaceFile {
  global?: { archivedSessionIds?: string[]; defaultWorkspaceId?: string };
  tables?: {
    workspaces?: Record<
      string,
      { path?: string; title?: string; sessionIds?: string[]; createdAt?: string; updatedAt?: string }
    >;
  };
}

function dshRoot(): string {
  return process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh');
}

function readWorkspace(): WorkspaceFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(dshRoot(), 'storages', 'workspace.json'), 'utf8')) as WorkspaceFile;
  } catch {
    return {};
  }
}

/** session id -> absolute event-log path, discovered from the sessions tree once. */
function sessionPaths(): Map<string, string> {
  const out = new Map<string, string>();
  const root = path.join(dshRoot(), 'sessions');
  if (!fs.existsSync(root)) return out;
  for (const encoded of fs.readdirSync(root)) {
    const dir = path.join(root, encoded);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith('session-')) continue;
      out.set(child.name, path.join(dir, child.name, 'session.v4.jsonl.zstd'));
    }
  }
  return out;
}

function readProjCache(sessionId: string): ProjCacheFile | undefined {
  const file = path.join(dshRoot(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjCacheFile;
  } catch {
    return undefined;
  }
}

/**
 * DSH delivers harness-injected material as ordinary `user/message` events and
 * distinguishes it only by `data.source.kind`. Mirroring must keep the human
 * turns and drop the injection, or every copy would grow a new runtime-context
 * message each round.
 */
const HUMAN_USER_SOURCES = new Set(['user', 'agent-message']);

function isHumanUserEvent(data: Record<string, unknown>): boolean {
  const source = (data.source ?? {}) as Record<string, unknown>;
  const kind = typeof source.kind === 'string' ? source.kind : '';
  return HUMAN_USER_SOURCES.has(kind);
}

function blocksOfEvent(
  event: Record<string, unknown>,
  includeToolCalls: boolean,
): { role: Message['role']; blocks: Block[] } | undefined {
  const type = event.type as string | undefined;
  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'user/message': {
      if (!isHumanUserEvent(data)) return undefined;
      const blocks = contentBlocks(data.content, includeToolCalls);
      return blocks.length ? { role: 'user', blocks } : undefined;
    }
    case 'assistant/message': {
      const message = (data.message ?? {}) as Record<string, unknown>;
      const blocks = contentBlocks(message.content, includeToolCalls);
      return blocks.length ? { role: 'assistant', blocks } : undefined;
    }
    case 'tool/call': {
      return {
        role: 'assistant',
        blocks: [
          {
            type: 'toolCall',
            callId: String(data.callId ?? ''),
            name: String(data.name ?? 'tool'),
            input: String(data.arguments ?? ''),
          },
        ],
      };
    }
    case 'tool/result': {
      const message = (data.message ?? {}) as Record<string, unknown>;
      const content = contentBlocks(message.content, includeToolCalls);
      const output = content
        .filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return {
        role: 'tool',
        blocks: [
          {
            type: 'toolResult',
            // v4 stores the tool id on the result message (and sometimes its
            // tool source), not at the event-data root.
            callId: String(message.toolCallId ?? (message.source as Record<string, unknown> | undefined)?.callId ?? data.toolCallId ?? ''),
            output,
            images: content.filter((block): block is Extract<Block, { type: 'image' }> => block.type === 'image'),
            isError: Boolean((message as Record<string, unknown>).isError),
          },
        ],
      };
    }
    default:
      return undefined;
  }
}

/** Codex's synthetic pointer at an attachment file, not something a human said. */
function isAttachmentMarker(text: unknown): boolean {
  return typeof text === 'string' && /^<image name=\[Image #\d+\] path="[^"]+">$/.test(text.trim());
}

/** Presentation-only tool summary written by the Codex mirror; never conversation. */
function isToolSummary(text: unknown): boolean {
  return typeof text === 'string' && /^(?:（执行了 \d+ 个操作|（工具调用：|调用工具：|Script (?:completed|failed)\s+Wall time|Companion Page snapshot part \d+ of \d+:)/.test(text.trim());
}

function contentBlocks(content: unknown, includeToolCalls = false): Block[] {
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        // Older mirror builds wrote Codex's `<image ... path>` marker as a user
        // message of its own; it is bookkeeping, never part of the conversation.
        if (isAttachmentMarker(block.text)) break;
        if (isToolSummary(block.text)) break;
        if (typeof block.text === 'string' && block.text.trim().startsWith('# AGENTS.md instructions') && block.text.includes('<environment_context>')) break;
        if (typeof block.text === 'string' && block.text.trim()) blocks.push({ type: 'text', text: block.text });
        break;
      case 'reasoning':
        if (typeof block.text === 'string' && block.text.trim()) blocks.push({ type: 'reasoning', text: block.text });
        break;
      case 'tool-call':
        // A tool call is normally also a `tool/call` event. Reading both would
        // duplicate it, so content blocks only stand in when the session has no
        // dedicated call events at all.
        if (includeToolCalls) {
          blocks.push({
            type: 'toolCall',
            callId: String(block.callId ?? block.id ?? ''),
            name: String(block.name ?? 'tool'),
            input: String(block.arguments ?? block.input ?? ''),
          });
        }
        break;
      case 'image': {
        const attachment = (block.attachment ?? block.image ?? {}) as Record<string, unknown>;
        const mime = String(attachment.mediaType ?? attachment.mimeType ?? attachment.mime ?? 'image/*');
        const ref = String(attachment.attachmentId ?? attachment.id ?? attachment.path ?? '');
        const asset = ref.startsWith('sha256:') ? readDshImage(ref, mime, attachment.name as string) : undefined;
        blocks.push({ type: 'image', mime, ref, ...(asset ? { data: asset.base64 } : {}) });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/** The session header lives in the first frame, so this stays cheap. */
function headerOf(file: string): Record<string, unknown> | undefined {
  try {
    const bytes = fs.readFileSync(file);
    const { frames } = scanZstdFrames(bytes, 1);
    if (frames.length === 0) return undefined;
    const text = zlib.zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8');
    const first = text.split('\n')[0];
    return first ? (JSON.parse(first) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function decompress(file: string): string {
  return decompressFrames(file, fs.readFileSync(file));
}

export class DshReader implements Reader {
  readonly origin = 'dsh' as const;

  async list(): Promise<ConversationMeta[]> {
    const paths = sessionPaths();
    const workspace = readWorkspace();
    const archived = new Set(workspace.global?.archivedSessionIds ?? []);
    const membership = new Map<string, { id: string; title: string; path: string }>();
    for (const [workspaceId, entry] of Object.entries(workspace.tables?.workspaces ?? {})) {
      for (const sessionId of entry.sessionIds ?? []) {
        membership.set(sessionId, {
          // keep the workspace id: it is what the sidebar groups by
          id: workspaceId,
          title: entry.title ?? safeBasename(entry.path ?? workspaceId),
          path: entry.path ?? '',
        });
      }
    }

    const out: ConversationMeta[] = [];
    for (const [sessionId, file] of paths) {
      // Subagent sessions belong to a parent conversation; the app does not list
      // them as conversations of their own either.
      const header = headerOf(file);
      if (header && (header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0)) continue;
      const cache = readProjCache(sessionId);
      const identity = cache?.record?.identity;
      const title = cache?.record?.rows?.title?.val ?? '';
      // Clicking "new conversation" in DSH persists a session shell immediately,
      // even if nothing is ever sent. It has no title, no human message and no
      // turn, so listing it would add an "(untitled)" row that cannot be opened
      // or mirrored. The projection cache answers that without decompressing.
      const userMessages = cache?.record?.rows?.titleInput?.val?.count ?? 0;
      const turns = cache?.record?.rows?.sessionStats?.val?.turns ?? 0;
      if (cache && !title && userMessages === 0 && turns === 0) continue;
      const member = membership.get(sessionId);
      const cwd = identity?.cwd ?? member?.path ?? '';
      const createdAt = identity?.createdAt ?? 0;
      let updatedAt = createdAt;
      try {
        updatedAt = fs.statSync(file).mtimeMs;
      } catch {
        // keep createdAt
      }
      out.push({
        origin: 'dsh',
        sourceId: sessionId,
        projectName: member?.title || (cwd ? safeBasename(cwd) : 'unknown'),
        projectId: member?.id ?? (cwd || undefined),
        cwd,
        title: title || '(untitled)',
        createdAt,
        updatedAt,
        archived: archived.has(sessionId),
        path: file,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(sourceId: string): Promise<Conversation> {
    const file = sessionPaths().get(sourceId);
    if (!file) throw new Error(`dsh session not found: ${sourceId}`);
    const meta = (await this.list()).find((item) => item.sourceId === sourceId);
    if (!meta) throw new Error(`dsh session metadata not found: ${sourceId}`);

    const events: Array<Record<string, unknown>> = [];
    for (const line of decompress(file).split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    const hasCallEvents = events.some((event) => event.type === 'tool/call');

    const messages: Message[] = [];
    let title = meta.title;
    let seq = 0;
    for (const event of events) {
      if (event.type === 'session/title') {
        const data = (event.data ?? {}) as Record<string, unknown>;
        if (typeof data.title === 'string' && data.title.trim()) title = data.title;
        continue;
      }
      const mapped = blocksOfEvent(event, !hasCallEvents);
      if (!mapped) continue;
      messages.push({
        id: String(((event.data ?? {}) as Record<string, unknown>).id ?? `dsh-${seq++}`),
        role: mapped.role,
        time: typeof event.time === 'number' ? event.time : undefined,
        blocks: mapped.blocks,
      });
    }

    return {
      ...meta,
      title: title === '(untitled)' ? deriveTitle(messages) : title,
      // Identical image bytes can be intentionally re-sent in a later turn (or
      // shown again by the assistant). Content-addressed equality is not a
      // message identity, so never deduplicate conversation turns by image hash.
      messages,
    };
  }
}

export { encodeDshCwd };
