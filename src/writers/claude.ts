import fs from 'node:fs';
import path from 'node:path';

import type { Block, Conversation } from '../ir.ts';
import { canonicalize, deriveTitle } from '../ir.ts';
import { encodeClaudeCwd } from '../paths.ts';

/**
 * Claude Code needs nothing but the transcript file:
 *
 *   <home>/projects/<encoded-cwd>/<uuid>.jsonl
 *
 * `claude --resume <uuid>` resolves it from the file, provided the encoded
 * directory matches the cwd the CLI is launched from. Rows form a linear chain
 * through `parentUuid`, so the writer keeps one previous-uuid cursor.
 */

interface ClaudeRowOut {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external';
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  type: 'user' | 'assistant';
  message: { role: 'user' | 'assistant'; content: unknown[] };
  uuid: string;
  timestamp: string;
}

function contentBlocks(blocks: Block[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text });
        break;
      case 'reasoning':
        out.push({ type: 'thinking', thinking: block.text, signature: '' });
        break;
      case 'toolCall':
        out.push({
          type: 'tool_use',
          id: block.callId || `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: block.name,
          input: safeJson(block.input),
        });
        break;
      case 'toolResult':
        out.push({
          type: 'tool_result',
          tool_use_id: block.callId,
          content: block.images?.length
            ? [
                ...(block.output ? [{ type: 'text', text: block.output }] : []),
                ...block.images.filter((image) => image.data).map((image) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: image.mime, data: image.data },
                })),
              ]
            : block.output,
          ...(block.isError ? { is_error: true } : {}),
        });
        break;
      case 'image':
        // Claude carries images inline as base64 source objects, so the bytes
        // must be present; a reference alone cannot be rendered.
        if (block.data) {
          out.push({
            type: 'image',
            source: { type: 'base64', media_type: block.mime, data: block.data },
          });
        }
        break;
    }
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export interface ClaudeRowPlan {
  rows: ClaudeRowOut[];
  lastUuid: string | null;
}

/** Builds the transcript rows for a conversation, continuing an existing chain. */
export function buildClaudeRows(
  conversation: Conversation,
  sessionId: string,
  startParent: string | null = null,
  startIndex = 0,
): ClaudeRowPlan {
  const rows: ClaudeRowOut[] = [];
  let parent = startParent;
  let index = startIndex;
  for (const message of canonicalize(conversation.messages)) {
    const content = contentBlocks(message.blocks);
    if (content.length === 0) continue;
    const uuid = crypto.randomUUID();
    rows.push({
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd: conversation.cwd,
      sessionId,
      version: '2.1.310',
      gitBranch: '',
      type: message.role === 'assistant' ? 'assistant' : 'user',
      message: { role: message.role === 'assistant' ? 'assistant' : 'user', content },
      uuid,
      timestamp: new Date(message.time ?? conversation.createdAt + index * 1000).toISOString(),
    });
    parent = uuid;
    index += 1;
  }
  return { rows, lastUuid: parent };
}

export interface ClaudeWriteOptions {
  /** Overrides `~/.claude`, used by tests and by dry runs. */
  home?: string;
  /** Reuse an existing session id when updating a mirrored conversation. */
  sessionId?: string;
}

export interface ClaudeWriteResult {
  sessionId: string;
  path: string;
  rows: number;
  title: string;
}

/** Writes the conversation as a resumable Claude Code transcript. */
export function writeClaude(conversation: Conversation, options: ClaudeWriteOptions = {}): ClaudeWriteResult {
  const home = options.home ?? path.join(process.env.HOME ?? '', '.claude');
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const dir = path.join(home, 'projects', encodeClaudeCwd(conversation.cwd));
  fs.mkdirSync(dir, { recursive: true });

  const { rows } = buildClaudeRows(conversation, sessionId);
  const file = path.join(dir, `${sessionId}.jsonl`);
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, file);

  return {
    sessionId,
    path: file,
    rows: rows.length,
    title: conversation.title || deriveTitle(conversation.messages),
  };
}

/** Appends new turns to an existing transcript, keeping the parent chain intact. */
export function appendClaude(
  conversation: Conversation,
  sessionId: string,
  options: ClaudeWriteOptions = {},
): { path: string; rows: number } {
  const home = options.home ?? path.join(process.env.HOME ?? '', '.claude');
  const file = path.join(home, 'projects', encodeClaudeCwd(conversation.cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`claude session not found: ${file}`);

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let lastUuid: string | null = null;
  let index = lines.length;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { uuid?: string };
      if (row.uuid) lastUuid = row.uuid;
    } catch {
      continue;
    }
  }

  const { rows } = buildClaudeRows(conversation, sessionId, lastUuid, index);
  if (rows.length === 0) return { path: file, rows: 0 };
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n').concat('\n'), 'utf8');
  return { path: file, rows: rows.length };
}
