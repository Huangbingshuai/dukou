import fs from 'node:fs';
import path from 'node:path';

import type { Block, Conversation, ConversationMeta, Message, Reader } from '../ir.ts';
import { deriveTitle } from '../ir.ts';
import { decodeToolOutput } from '../tool-output.ts';
import { findFiles, readJsonLines } from '../paths.ts';

/**
 * Claude Code stores one JSONL transcript per session:
 *
 *   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 *
 * No index write is needed: `claude --resume <uuid>` resolves the transcript
 * from the file alone, as long as the encoded directory matches the cwd you
 * launch from. The file also carries `cwd` on its user rows, which is more
 * reliable than decoding the directory name.
 */

interface ClaudeRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.trim()) blocks.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          blocks.push({ type: 'reasoning', text: block.thinking });
        }
        break;
      case 'tool_use':
        blocks.push({
          type: 'toolCall',
          callId: String(block.id ?? ''),
          name: String(block.name ?? 'tool'),
          input: unwrapToolInput(block.input),
        });
        break;
      case 'tool_result': {
        const decoded = decodeToolOutput(block.content);
        blocks.push({
          type: 'toolResult',
          callId: String(block.tool_use_id ?? ''),
          output: decoded.text,
          images: decoded.images,
          isError: Boolean(block.is_error),
        });
        break;
      }
      case 'image': {
        const source = block.source as Record<string, unknown> | undefined;
        const data = typeof source?.data === 'string' ? source.data : undefined;
        blocks.push({
          type: 'image',
          mime: String(source?.media_type ?? 'image/*'),
          ref: String(source?.url ?? ''),
          ...(data ? { data } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function blocksText(content: unknown): string {
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

function sessionFiles(): string[] {
  const root = process.env.CLAUDE_HOME ?? path.join(process.env.HOME ?? '', '.claude');
  const dir = path.join(root, 'projects');
  if (!fs.existsSync(dir)) return [];
  return findFiles(dir, (file) => file.endsWith('.jsonl'));
}

function metaOf(file: string): ConversationMeta | undefined {
  let rows: ClaudeRow[];
  try {
    rows = readJsonLines(file) as ClaudeRow[];
  } catch {
    return undefined;
  }
  const cwd = rows.find((row) => typeof row.cwd === 'string' && row.cwd)?.cwd ?? '';
  const firstUser = rows.find(
    (row) => row.type === 'user' && !row.isSidechain && row.message?.role === 'user',
  );
  const title = firstUser ? blocksText(firstUser.message?.content).replace(/\s+/g, ' ').slice(0, 80) : '';
  const stat = fs.statSync(file);
  const firstTime = rows.find((row) => row.timestamp)?.timestamp;
  return {
    origin: 'claude',
    sourceId: path.basename(file, '.jsonl'),
    projectName: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
    projectId: cwd || path.dirname(file),
    cwd,
    title: title || '(untitled)',
    createdAt: firstTime ? Date.parse(firstTime) : stat.birthtimeMs,
    updatedAt: stat.mtimeMs,
    archived: false,
    path: file,
  };
}

/**
 * Claude stores tool input as an object, so a raw string argument arrives wrapped as
 * `{ raw: text }`. Show the text the tool actually received.
 */
function unwrapToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    typeof (input as { raw?: unknown }).raw === 'string'
  ) {
    return (input as { raw: string }).raw;
  }
  return JSON.stringify(input ?? {});
}

export class ClaudeReader implements Reader {
  readonly origin = 'claude' as const;

  async list(): Promise<ConversationMeta[]> {
    const out: ConversationMeta[] = [];
    for (const file of sessionFiles()) {
      const meta = metaOf(file);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(sourceId: string): Promise<Conversation> {
    const meta = (await this.list()).find((item) => item.sourceId === sourceId);
    if (!meta) throw new Error(`claude session not found: ${sourceId}`);

    const messages: Message[] = [];
    let seq = 0;
    for (const row of readJsonLines(meta.path) as ClaudeRow[]) {
      if (row.type !== 'user' && row.type !== 'assistant') continue;
      const role = row.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const blocks = blocksOf(row.message?.content);
      if (blocks.length === 0) continue;
      // A marker-only turn is Codex's synthetic attachment pointer, not speech.
      if (role === 'user' && blocks.every((b) => b.type === 'text' && /^<image name=\[Image #\d+\] path="[^"]+">$/.test(b.text.trim()))) {
        continue;
      }
      // Claude carries tool results on `user` rows; the canonical role is `tool`
      // so replicas of the same conversation compare equal across harnesses.
      const canonicalRole = blocks.every((block) => block.type === 'toolResult') ? 'tool' : role;
      messages.push({
        id: row.uuid ?? `claude-${seq++}`,
        role: canonicalRole,
        time: row.timestamp ? Date.parse(row.timestamp) : undefined,
        blocks,
      });
    }

    return {
      ...meta,
      title: meta.title === '(untitled)' ? deriveTitle(messages) : meta.title,
      messages,
    };
  }
}
