import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Block, Conversation, ConversationMeta, Message, Reader } from '../ir.ts';
import { deriveTitle } from '../ir.ts';

type JsonObject = Record<string, unknown>;
interface SessionRow extends JsonObject {
  id: string; directory: string; title: string; time_created: number; time_updated: number;
  time_archived?: number | null; time_deleted?: number | null; project_id?: string;
}
interface MessageRow { id: string; session_id: string; time_created: number; sequence?: number | null; data: string }
interface PartRow { id: string; message_id: string; time_created: number; sequence?: number | null; data: string }

function zcodeHome(): string { return process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode'); }
function dbPath(): string { return path.join(zcodeHome(), 'cli', 'db', 'db.sqlite'); }
function parseJson(value: string): JsonObject {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed as JsonObject : {}; }
  catch { return {}; }
}
function database(): DatabaseSync | undefined {
  const file = dbPath();
  if (!fs.existsSync(file)) return undefined;
  return new DatabaseSync(file, { readOnly: true });
}
function assertSchema(db: DatabaseSync): void {
  const required: Record<string, string[]> = {
    session: ['id', 'directory', 'title', 'time_created', 'time_updated'],
    message: ['id', 'session_id', 'time_created', 'data'],
    part: ['id', 'message_id', 'time_created', 'data'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const found = new Set((db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    if (columns.some((column) => !found.has(column))) throw new Error(`Unsupported ZCode database schema: ${table} table is missing required columns`);
  }
}

/** Read-only ZCode session database adapter; never opens its store for writes. */
export class ZcodeReader implements Reader {
  readonly origin = 'zcode' as const;

  async list(): Promise<ConversationMeta[]> {
    const db = database();
    if (!db) return [];
    try {
      assertSchema(db);
      const rows = db.prepare('select * from session where time_deleted is null order by time_updated desc, id asc').all() as SessionRow[];
      return rows.map((row) => this.meta(row));
    } finally { db.close(); }
  }

  async read(sourceId: string): Promise<Conversation> {
    const db = database();
    if (!db) throw new Error(`zcode session not found: ${sourceId}`);
    try {
      assertSchema(db);
      const row = db.prepare('select * from session where id = ? and time_deleted is null').get(sourceId) as SessionRow | undefined;
      if (!row) throw new Error(`zcode session not found: ${sourceId}`);
      const meta = this.meta(row);
      const messageRows = db.prepare(`select id, session_id, time_created, sequence, data from message where session_id = ? order by coalesce(sequence, time_created), time_created, id`).all(sourceId) as MessageRow[];
      const parts = db.prepare(`select p.id, p.message_id, p.time_created, p.sequence, p.data from part p join message m on m.id = p.message_id where p.session_id = ? order by p.message_id, coalesce(p.sequence, p.time_created), p.time_created, p.id`).all(sourceId) as PartRow[];
      const partsByMessage = new Map<string, PartRow[]>();
      for (const part of parts) partsByMessage.set(part.message_id, [...(partsByMessage.get(part.message_id) ?? []), part]);
      const messages: Message[] = [];
      for (const message of messageRows) {
        const data = parseJson(message.data);
        const role = data.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') continue;
        for (const part of partsByMessage.get(message.id) ?? []) {
          const blocks = this.blocks(parseJson(part.data), sourceId);
          blocks.forEach((block, index) => messages.push({
            id: `${message.id}:${part.id}:${index}`,
            role: block.type === 'toolResult' ? 'tool' : role,
            time: part.time_created || message.time_created || undefined,
            blocks: [block],
          }));
        }
      }
      return { ...meta, title: meta.title === '(untitled)' ? deriveTitle(messages) : meta.title, messages };
    } finally { db.close(); }
  }

  private meta(row: SessionRow): ConversationMeta {
    const cwd = typeof row.directory === 'string' ? row.directory : '';
    return {
      origin: this.origin,
      sourceId: row.id,
      projectName: cwd ? path.basename(cwd) : 'ZCode',
      projectId: typeof row.project_id === 'string' ? row.project_id : undefined,
      cwd,
      title: typeof row.title === 'string' && row.title.trim() ? row.title : '(untitled)',
      createdAt: Number(row.time_created) || 0,
      updatedAt: Number(row.time_updated) || 0,
      archived: row.time_archived !== null && row.time_archived !== undefined,
      path: dbPath(),
    };
  }

  private imageFromPart(part: JsonObject, sessionId: string): Extract<Block, { type: 'image' }> | undefined {
    if (part.type !== 'image' && part.type !== 'file') return undefined;
    const mime = String(part.mime ?? part.mediaType ?? part.mimeType ?? 'image/*');
    if (!mime.startsWith('image/')) return undefined;
    const direct = typeof part.data === 'string' ? part.data : '';
    const url = typeof part.url === 'string' ? part.url : '';
    const dataUrl = url.startsWith('data:image/') ? url : '';
    let data = direct || dataUrl.replace(/^data:[^,]*;base64,/, '');
    if (!data && url.startsWith(`zcode-artifact://${sessionId}/`)) {
      const artifactId = decodeURIComponent(url.slice(`zcode-artifact://${sessionId}/`.length));
      const root = path.resolve(zcodeHome(), 'cli', 'artifacts', sessionId);
      if (artifactId && !artifactId.includes('/') && !artifactId.includes('\\') && fs.existsSync(root)) {
        const name = fs.readdirSync(root).find((entry) => entry.includes(artifactId));
        if (name) {
          const file = path.resolve(root, name);
          if (file.startsWith(`${root}${path.sep}`) && fs.existsSync(file)) {
            const bytes = fs.readFileSync(file);
            const content = bytes.toString('utf8');
            const storedDataUrl = content.match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
            data = storedDataUrl?.[2] ?? bytes.toString('base64');
          }
        }
      }
    }
    if (!data && url.startsWith('file:')) {
      try {
        const root = path.resolve(zcodeHome(), 'cli', 'artifacts', sessionId);
        const file = path.resolve(fileURLToPath(url));
        if (file.startsWith(`${root}${path.sep}`) && fs.existsSync(file)) data = fs.readFileSync(file).toString('base64');
      } catch { /* invalid or non-local file URL */ }
    }
    return { type: 'image', mime, ref: url || String(part.path ?? ''), ...(data ? { data } : {}) };
  }

  private blocks(part: JsonObject, sessionId: string): Block[] {
    switch (part.type) {
      case 'text': return typeof part.text === 'string' && part.text.trim() ? [{ type: 'text', text: part.text }] : [];
      case 'reasoning': case 'thinking': return typeof part.text === 'string' && part.text.trim() ? [{ type: 'reasoning', text: part.text }] : [];
      case 'tool': case 'tool_use': {
        const state = part.state && typeof part.state === 'object' ? part.state as JsonObject : {};
        const callId = String(part.callID ?? part.callId ?? part.id ?? '');
        const blocks: Block[] = [{ type: 'toolCall', callId, name: String(part.tool ?? part.name ?? 'tool'), input: JSON.stringify(state.input ?? part.input ?? {}) }];
        if (state.output !== undefined || state.error !== undefined || state.status === 'error') {
          const output = state.output ?? state.error ?? '';
          const attachments = Array.isArray(state.attachments) ? state.attachments as JsonObject[] : [];
          const images = attachments.map((item) => this.imageFromPart(item, sessionId)).filter((item): item is Extract<Block, { type: 'image' }> => Boolean(item));
          blocks.push({ type: 'toolResult', callId, output: typeof output === 'string' ? output : JSON.stringify(output), ...(images.length ? { images } : {}), isError: state.status === 'error' || state.error !== undefined });
        }
        return blocks;
      }
      case 'tool_result': case 'toolResult': {
        const output = part.output ?? part.text ?? '';
        const content = Array.isArray(output) ? output as JsonObject[] : [];
        const images = content.map((item) => this.imageFromPart(item, sessionId)).filter((item): item is Extract<Block, { type: 'image' }> => Boolean(item));
        const text = content.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => String(item.text)).join('\n');
        return [{ type: 'toolResult', callId: String(part.callID ?? part.callId ?? ''), output: typeof output === 'string' ? output : text || (content.length ? '' : JSON.stringify(output)), ...(images.length ? { images } : {}), isError: Boolean(part.isError) }];
      }
      case 'image': case 'file': {
        const image = this.imageFromPart(part, sessionId);
        return image ? [image] : [];
      }
      default: return [];
    }
  }
}
