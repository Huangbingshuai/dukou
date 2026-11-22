import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Block, Conversation, ConversationMeta, Message, Reader } from '../ir.ts';
import { deriveTitle } from '../ir.ts';
import { readFirstLine, readJsonLines } from '../paths.ts';
import { fromDataUrl } from '../attachments.ts';
import { decodeToolOutput } from '../tool-output.ts';

/**
 * Codex Desktop keeps three stores, and content lives in the first two:
 *
 *  1. `sessions/YYYY/MM/DD/rollout-*.jsonl` — the append-only event log. Only the
 *     newest threads still have one: older rollouts get compacted away.
 *  2. `thread_history_1.sqlite` `thread_items` — the durable paginated projection
 *     (`item_json` per UI item, ordered by `rollout_ordinal`). This is what the
 *     app actually renders, so it must be a read source, not just a write target.
 *  3. `state_5.sqlite` `threads`/`projects` — the index the sidebar lists from.
 *
 * `thread_history_projection_state` records how far each rollout has been folded
 * into the projection (`next_rollout_byte_offset`/`next_rollout_ordinal`). A
 * thread with no state row is projected from byte 0 on first open, which is why
 * a writer can publish a rollout and let Codex build the projection itself.
 */

export interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  cwd: string;
  title: string;
  name: string | null;
  archived: number;
  project_id: string | null;
  source: string;
  thread_source: string | null;
  agent_role: string | null;
  first_user_message: string;
}

interface CodexIndex {
  threads: Map<string, CodexThreadRow>;
  projects: Map<string, string>;
  /** project root path -> project id, for threads the app filed by folder only */
  roots: Map<string, string>;
}

const SYNTHETIC_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<turn_aborted>',
  '<permissions',
  '<EXTERNAL SESSION IMPORTED>',
];

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
}

function openReadOnly(file: string): DatabaseSync | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      return new DatabaseSync(`file:${file}?immutable=1`, { readOnly: true });
    } catch {
      return undefined;
    }
  }
}

function readIndex(): CodexIndex {
  const threads = new Map<string, CodexThreadRow>();
  const projects = new Map<string, string>();
  const roots = new Map<string, string>();
  const db = openReadOnly(path.join(codexHome(), 'state_5.sqlite'));
  if (!db) return { threads, projects, roots };
  try {
    for (const row of db.prepare('select id, name from projects').all() as Array<{ id: string; name: string }>) {
      projects.set(row.id, row.name);
    }
    try {
      for (const row of db.prepare('select project_id, path from project_roots').all() as Array<{
        project_id: string;
        path: string;
      }>) {
        roots.set(row.path, row.project_id);
      }
    } catch {
      // older stores may lack project_roots; the id column still works
    }
    const rows = db
      .prepare(
        `select id, rollout_path, created_at, updated_at, cwd, title, name, archived, project_id, source,
                thread_source, agent_role, first_user_message
           from threads`,
      )
      .all() as CodexThreadRow[];
    for (const row of rows) threads.set(row.id, row);
  } catch {
    // A locked or migrated store must not stop a read-only listing.
  } finally {
    db.close();
  }
  return { threads, projects, roots };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const block = raw as Record<string, unknown>;
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    (trimmed.startsWith('# AGENTS.md instructions') && trimmed.includes('<environment_context>'));
}

function isMirrorPresentationText(text: string): boolean {
  return /^(?:（执行了 \d+ 个操作|（工具调用：|调用工具：|Script (?:completed|failed)\s+Wall time|Companion Page snapshot part \d+ of \d+:)/.test(text.trim());
}

/** Maps one `response_item` payload into IR blocks, or nothing when it is runtime noise. */
function mapResponseItem(payload: Record<string, unknown>): { role: Message['role']; blocks: Block[] } | undefined {
  switch (payload.type as string | undefined) {
    case 'message': {
      const role = payload.role as string | undefined;
      const text = textOfContent(payload.content);
      if (role === 'user') {
        if (text.trim() && isSyntheticUserText(text)) return undefined;
        const blocks: Block[] = [];
        // `<image name=[Image #n] path="...">` is Codex's attachment pointer; an
        // older mirror build turned it into a user message of its own.
        const cleanText = /^<image name=\[Image #\d+\] path="[^"]+">$/.test(text.trim()) ? '' : text;
        if (cleanText.trim()) blocks.push({ type: 'text', text: cleanText });
        if (Array.isArray(payload.content)) {
          for (const raw of payload.content as Array<Record<string, unknown>>) {
            if (raw.type === 'input_image') {
              const url = String(raw.image_url ?? '');
              const asset = fromDataUrl(url);
              blocks.push({
                type: 'image',
                mime: asset?.mime ?? 'image/*',
                ref: asset ? '' : url.slice(0, 256),
                ...(asset ? { data: asset.base64 } : {}),
              });
            }
          }
        }
        return blocks.length ? { role: 'user', blocks } : undefined;
      }
      if (role === 'assistant') {
        const blocks: Block[] = [];
        if (text.trim() && !isMirrorPresentationText(text)) blocks.push({ type: 'text', text });
        if (Array.isArray(payload.content)) {
          for (const raw of payload.content as Array<Record<string, unknown>>) {
            if (raw.type !== 'output_image') continue;
            const asset = fromDataUrl(String(raw.image_url ?? ''));
            if (asset) blocks.push({ type: 'image', mime: asset.mime, ref: '', data: asset.base64 });
          }
        }
        return blocks.length ? { role: 'assistant', blocks } : undefined;
      }
      return undefined;
    }
    case 'reasoning': {
      const text = textOfContent(payload.summary) || textOfContent(payload.content);
      return text.trim() ? { role: 'assistant', blocks: [{ type: 'reasoning', text }] } : undefined;
    }
    case 'function_call':
    case 'custom_tool_call': {
      return {
        role: 'assistant',
        blocks: [
          {
            type: 'toolCall',
            callId: String(payload.call_id ?? payload.id ?? ''),
            name: String(payload.name ?? 'tool'),
            input: String(payload.arguments ?? payload.input ?? ''),
          },
        ],
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const decoded = decodeToolOutput(payload.output);
      return {
        role: 'tool',
        blocks: [{ type: 'toolResult', callId: String(payload.call_id ?? payload.id ?? ''), output: decoded.text, images: decoded.images }],
      };
    }
    default:
      return undefined;
  }
}

function shortPath(value: unknown): string {
  const text = String(value ?? '');
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? text : `…/${parts.slice(-2).join('/')}`;
}

function changeVerb(kind: unknown): string {
  const type = typeof kind === 'string' ? kind : (kind as { type?: string } | undefined)?.type;
  if (type === 'add') return '新增';
  if (type === 'delete') return '删除';
  return '修改';
}

/**
 * Maps one projected `thread_items.item_json` into IR.
 *
 * These items keep the raw tool record (`pluginId`, `processId`, diffs), which is
 * unreadable in a transcript. Only the parts a reader needs are kept: what ran,
 * on which file, and what came back.
 */
function mapProjectedItem(item: Record<string, unknown>): Message[] {
  const type = item.type as string | undefined;
  const id = String(item.id ?? type ?? '');

  switch (type) {
    case 'userMessage': {
      const text = textOfContent(item.content);
      if (!text.trim() || isSyntheticUserText(text)) return [];
      return [{ id, role: 'user', blocks: [{ type: 'text', text }] }];
    }
    case 'agentMessage': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (isMirrorPresentationText(text)) return [];
      return text.trim() ? [{ id, role: 'assistant', blocks: [{ type: 'text', text }] }] : [];
    }
    case 'reasoning': {
      const text = textOfContent(item.summary) || textOfContent(item.content);
      return text.trim() ? [{ id, role: 'assistant', blocks: [{ type: 'reasoning', text }] }] : [];
    }
    case 'commandExecution': {
      const command = String(item.command ?? '');
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
      const failed = item.status === 'failed';
      const messages: Message[] = [
        { id, role: 'assistant', blocks: [{ type: 'toolCall', callId: id, name: '运行', input: command }] },
      ];
      if (output.trim()) {
        messages.push({
          id: `${id}-out`,
          role: 'tool',
          blocks: [{ type: 'toolResult', callId: id, output, isError: failed }],
        });
      }
      return messages;
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
      const lines = changes.map((change) => `${changeVerb(change.kind)} ${shortPath(change.path)}`);
      if (lines.length === 0) return [];
      return [
        {
          id,
          role: 'assistant',
          blocks: [{ type: 'toolCall', callId: id, name: '改文件', input: lines.join('\n') }],
        },
      ];
    }
    case 'mcpToolCall': {
      const server = String(item.server ?? '');
      const tool = String(item.tool ?? '');
      const args = JSON.stringify(item.arguments ?? {}).slice(0, 400);
      return [
        {
          id,
          role: 'assistant',
          blocks: [{ type: 'toolCall', callId: id, name: `${server}.${tool}`, input: args }],
        },
      ];
    }
    case 'webSearch': {
      const query = String(item.query ?? '');
      return [{ id, role: 'assistant', blocks: [{ type: 'toolCall', callId: id, name: '搜索', input: query }] }];
    }
    case 'imageView': {
      const file = String(item.path ?? '');
      // The picture itself lives in ~/.codex/attachments; show it, not its path.
      try {
        if (file && fs.existsSync(file)) {
          const ext = path.extname(file).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          return [
            {
              id,
              role: 'assistant',
              blocks: [{ type: 'image', mime, ref: file, data: fs.readFileSync(file).toString('base64') }],
            },
          ];
        }
      } catch {
        // fall through to the text form
      }
      return [
        { id, role: 'assistant', blocks: [{ type: 'toolCall', callId: id, name: '看图', input: shortPath(file) }] },
      ];
    }
    case 'contextCompaction': {
      return [{ id, role: 'assistant', blocks: [{ type: 'reasoning', text: '（上下文已压缩）' }] }];
    }
    case 'plan': {
      const text = typeof item.text === 'string' ? item.text : JSON.stringify(item).slice(0, 200);
      return [{ id, role: 'assistant', blocks: [{ type: 'text', text }] }];
    }
    default: {
      const rest = { ...item } as Record<string, unknown>;
      delete rest.type;
      delete rest.id;
      return [
        {
          id,
          role: 'assistant',
          blocks: [{ type: 'toolCall', callId: id, name: type ?? '工具', input: JSON.stringify(rest).slice(0, 200) }],
        },
      ];
    }
  }
}

function itemsFromProjection(threadId: string): Message[] | undefined {
  const db = openReadOnly(path.join(codexHome(), 'thread_history_1.sqlite'));
  if (!db) return undefined;
  const messages: Message[] = [];
  try {
    const rows = db
      .prepare(
        `select item_id, item_type, created_at_ms, item_json
           from thread_items where thread_id = ? order by rollout_ordinal asc`,
      )
      .all(threadId) as Array<{ item_id: string; item_type: string; created_at_ms: number; item_json: string }>;
    for (const row of rows) {
      let item: Record<string, unknown>;
      try {
        item = JSON.parse(row.item_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const mapped of mapProjectedItem(item)) {
        messages.push({ ...mapped, time: row.created_at_ms });
      }
    }
  } catch {
    return undefined;
  } finally {
    db.close();
  }
  return messages.length ? messages : undefined;
}

function messagesFromRollout(file: string): Message[] {
  const messages: Message[] = [];
  let seq = 0;
  for (const raw of readJsonLines(file)) {
    const row = raw as { type?: string; payload?: Record<string, unknown>; timestamp?: string };
    if (row.type !== 'response_item' || !row.payload) continue;
    const mapped = mapResponseItem(row.payload);
    if (!mapped) continue;
    messages.push({
      id: String(row.payload.id ?? `codex-${seq++}`),
      role: mapped.role,
      time: row.timestamp ? Date.parse(row.timestamp) : undefined,
      blocks: mapped.blocks,
    });
  }
  return messages;
}

function rolloutMeta(file: string): {
  id?: string;
  cwd?: string;
  timestamp?: string;
  threadSource?: string;
  agentRole?: string;
} {
  try {
    const first = JSON.parse(readFirstLine(file)) as { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    if (first.type !== 'session_meta') return {};
    const payload = first.payload ?? {};
    return {
      id: (payload.id ?? payload.session_id) as string | undefined,
      cwd: payload.cwd as string | undefined,
      timestamp: (payload.timestamp as string) ?? first.timestamp,
      threadSource: payload.thread_source as string | undefined,
      agentRole: payload.agent_role as string | undefined,
    };
  } catch {
    return {};
  }
}

function rolloutFiles(): string[] {
  const root = codexHome();
  const files: string[] = [];
  for (const dir of [path.join(root, 'sessions'), path.join(root, 'archived_sessions')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (entry.endsWith('.jsonl') && path.basename(entry).startsWith('rollout-')) files.push(path.join(dir, entry));
    }
  }
  return files.sort();
}

export class CodexReader implements Reader {
  readonly origin = 'codex' as const;
  #index: CodexIndex | undefined;

  #indexOnce(): CodexIndex {
    this.#index ??= readIndex();
    return this.#index;
  }

  async list(): Promise<ConversationMeta[]> {
    const { threads, projects, roots } = this.#indexOnce();
    const byId = new Map<string, ConversationMeta>();

    for (const row of threads.values()) {
      // The Codex app lists only the user's own, unarchived threads. Subagent
      // threads are part of a parent conversation and archived ones are hidden
      // behind a filter, so neither is a conversation of its own here.
      if (row.archived) continue;
      if (row.thread_source === 'subagent' || (row.agent_role && row.agent_role.length > 0)) continue;
      const hasRollout = Boolean(row.rollout_path) && fs.existsSync(row.rollout_path);
      // The app files a thread by its project id when it has one, and otherwise by
      // the folder it was started in — the same rule its sidebar uses.
      const projectId = row.project_id ?? roots.get(row.cwd) ?? undefined;
      byId.set(row.id, {
        origin: 'codex',
        sourceId: row.id,
        projectName: (projectId && projects.get(projectId)) || path.basename(row.cwd),
        projectId,
        cwd: row.cwd,
        // `name` is what the Codex app shows; `title` is often the raw first message.
        title: row.name?.trim() || row.title || row.first_user_message.slice(0, 80) || '(untitled)',
        createdAt: row.created_at * 1000,
        updatedAt: row.updated_at * 1000,
        archived: Boolean(row.archived) || !hasRollout && row.archived === 1,
        path: hasRollout ? row.rollout_path : '',
      });
    }

    // Rollouts Codex no longer indexes (imports, older builds) are still readable.
    for (const file of rolloutFiles()) {
      const meta = rolloutMeta(file);
      if (!meta.id || byId.has(meta.id)) continue;
      // Unindexed rollouts can be subagent runs too; the app never lists those.
      if (meta.threadSource === 'subagent' || (meta.agentRole && meta.agentRole.length > 0)) continue;
      const stat = fs.statSync(file);
      byId.set(meta.id, {
        origin: 'codex',
        sourceId: meta.id,
        projectName: path.basename(meta.cwd ?? ''),
        cwd: meta.cwd ?? '',
        title: '(untitled)',
        createdAt: meta.timestamp ? Date.parse(meta.timestamp) : stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
        archived: file.includes('archived_sessions'),
        path: file,
      });
    }

    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(sourceId: string): Promise<Conversation> {
    const meta = (await this.list()).find((item) => item.sourceId === sourceId);
    if (!meta) throw new Error(`codex session not found: ${sourceId}`);

    const fromRollout = meta.path && fs.existsSync(meta.path) ? messagesFromRollout(meta.path) : [];
    const messages = fromRollout.length > 0 ? fromRollout : (itemsFromProjection(sourceId) ?? []);

    return {
      ...meta,
      title: meta.title === '(untitled)' ? deriveTitle(messages) : meta.title,
      messages,
    };
  }
}
