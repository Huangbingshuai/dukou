import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Block, Conversation, ConversationMeta, Message, Reader } from '../ir.ts';
import { deriveTitle } from '../ir.ts';

type JsonObject = Record<string, unknown>;
interface KimiInstance { pid?: number; host?: string; port?: number; started_at?: string }
interface KimiSession extends JsonObject {
  id?: string; title?: string; created_at?: string; updated_at?: string; archived?: boolean;
  metadata?: JsonObject; workspace_id?: string;
}

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function instances(): KimiInstance[] {
  const dir = path.join(kimiHome(), 'server', 'instances');
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try { return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as KimiInstance]; }
      catch { return []; }
    }).filter((entry) => Number.isInteger(entry.port) && isLoopback(entry.host ?? '127.0.0.1'));
  } catch { return []; }
}

async function request<T>(base: string, token: string, endpoint: string): Promise<T> {
  const response = await fetch(`${base}${endpoint}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as { code?: number; msg?: string; data?: T };
  if (!response.ok || body.code !== 0) {
    throw new Error(`Kimi Code API ${response.status}${body.code ? ` (${body.code})` : ''}: ${body.msg ?? 'request failed'}`);
  }
  return body.data as T;
}

/** Read-only adapter backed by the official Kimi Code local Server API. */
export class KimiReader implements Reader {
  readonly origin = 'kimi' as const;
  private base?: string;
  private token?: string;

  private async connect(): Promise<{ base: string; token: string }> {
    if (this.base && this.token) return { base: this.base, token: this.token };
    let token: string;
    try { token = fs.readFileSync(path.join(kimiHome(), 'server.token'), 'utf8').trim(); }
    catch { throw new Error('Kimi Code local Server API token not found; open Kimi Code and enable its local server'); }
    if (!token) throw new Error('Kimi Code local Server API token is empty');
    for (const instance of instances()) {
      const base = `http://${instance.host ?? '127.0.0.1'}:${instance.port}`;
      try {
        await request(base, token, '/api/v1/meta');
        this.base = base;
        this.token = token;
        return { base, token };
      } catch { /* ignore stale instance registrations */ }
    }
    throw new Error('Kimi Code local Server API is not running');
  }

  private async page<T>(endpoint: string, base: string, token: string): Promise<T[]> {
    const all: T[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10000; page++) {
      const url = new URL(endpoint, 'http://dukou.local');
      url.searchParams.set('page_size', '100');
      if (before) url.searchParams.set('before_id', before);
      const result = await request<{ items?: T[]; has_more?: boolean }>(base, token, `${url.pathname}${url.search}`);
      const items = result.items ?? [];
      all.push(...items);
      if (!result.has_more || items.length === 0) return all;
      const last = items[items.length - 1] as JsonObject;
      if (typeof last.id !== 'string' || last.id === before) throw new Error('Kimi API returned an invalid pagination cursor');
      before = last.id;
    }
    throw new Error('Kimi API pagination exceeded the safety limit');
  }

  async list(): Promise<ConversationMeta[]> {
    const { base, token } = await this.connect();
    const rows = await this.page<KimiSession>('/api/v1/sessions?include_archive=true', base, token);
    return rows.filter((row) => typeof row.id === 'string').map((row) => {
      const cwd = typeof row.metadata?.cwd === 'string' ? row.metadata.cwd : '';
      return {
        origin: this.origin,
        sourceId: row.id as string,
        projectName: cwd ? path.basename(cwd) : String(row.workspace_id ?? 'Kimi Code'),
        projectId: String(row.workspace_id ?? ''),
        cwd,
        title: typeof row.title === 'string' && row.title.trim() ? row.title : '(untitled)',
        createdAt: Date.parse(String(row.created_at ?? '')) || 0,
        updatedAt: Date.parse(String(row.updated_at ?? '')) || 0,
        archived: Boolean(row.archived),
        path: `kimi://sessions/${encodeURIComponent(row.id as string)}`,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(sourceId: string): Promise<Conversation> {
    const meta = (await this.list()).find((row) => row.sourceId === sourceId);
    if (!meta) throw new Error(`kimi session not found: ${sourceId}`);
    const { base, token } = await this.connect();
    // Server API returns newest-first; walking before_id and reversing restores
    // the exact native order. Never stop at the first page.
    const rows = await this.page<JsonObject>(`/api/v1/sessions/${encodeURIComponent(sourceId)}/messages`, base, token);
    const messages: Message[] = [];
    for (const row of rows.reverse()) {
      const role = row.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') continue;
      const blocks = await this.contentBlocks(row.content, base, token, sourceId);
      if (!blocks.length) continue;
      messages.push({
        id: String(row.id ?? `kimi-${messages.length}`),
        role,
        time: Date.parse(String(row.created_at ?? '')) || undefined,
        blocks,
      });
    }
    return { ...meta, title: meta.title === '(untitled)' ? deriveTitle(messages) : meta.title, messages };
  }

  private async contentBlocks(content: unknown, base: string, token: string, sessionId: string): Promise<Block[]> {
    if (!Array.isArray(content)) return typeof content === 'string' && content.trim() ? [{ type: 'text', text: content }] : [];
    const blocks: Block[] = [];
    for (const item of content as JsonObject[]) {
      switch (item.type) {
        case 'text':
          if (typeof item.text === 'string' && item.text.trim()) blocks.push({ type: 'text', text: item.text });
          break;
        case 'thinking':
          if (typeof item.text === 'string' && item.text.trim()) blocks.push({ type: 'reasoning', text: item.text });
          break;
        case 'tool_use':
          blocks.push({ type: 'toolCall', callId: String(item.id ?? ''), name: String(item.name ?? 'tool'), input: JSON.stringify(item.input ?? {}) });
          break;
        case 'tool_result': {
          const payload = item.content ?? item.output;
          const nested = Array.isArray(payload) ? await this.contentBlocks(payload, base, token, sessionId) : [];
          const nestedText = nested.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('\n');
          blocks.push({
            type: 'toolResult',
            callId: String(item.tool_use_id ?? item.id ?? ''),
            output: typeof payload === 'string' ? payload : nestedText || JSON.stringify(payload ?? ''),
            images: nested.filter((block): block is Extract<Block, { type: 'image' }> => block.type === 'image'),
            isError: Boolean(item.is_error),
          });
          break;
        }
        case 'image': {
          const source = (item.source ?? {}) as JsonObject;
          const mime = String(source.media_type ?? item.mime_type ?? 'image/*');
          let data = typeof source.data === 'string' ? source.data : undefined;
          if (!data && typeof source.file_id === 'string') {
            const response = await fetch(`${base}/api/v1/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(source.file_id)}`, { headers: { authorization: `Bearer ${token}` } });
            if (response.ok) data = Buffer.from(await response.arrayBuffer()).toString('base64');
            else throw new Error(`Kimi image download failed (${response.status})`);
          }
          blocks.push({ type: 'image', mime, ref: typeof source.url === 'string' ? source.url : '', ...(data ? { data } : {}) });
          break;
        }
        default:
          // Unsupported payload types are deliberately not rewritten as text.
          break;
      }
    }
    return blocks;
  }
}
