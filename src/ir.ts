/**
 * The intermediate representation every adapter reads into and writes from.
 *
 * Design rule: the IR only holds what the participating harnesses can express natively.
 * Anything a target cannot represent is reported by the writer as a loss note,
 * never silently dropped.
 */

export type Origin = 'codex' | 'claude' | 'dsh' | 'kimi' | 'zcode';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface ImageBlock {
  type: 'image';
  mime: string;
  ref: string;
  data?: string;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; callId: string; name: string; input: string }
  | { type: 'toolResult'; callId: string; output: string; images?: ImageBlock[]; isError?: boolean }
  | ImageBlock;

export interface Message {
  id: string;
  role: Role;
  /** epoch millis when the source recorded one */
  time?: number;
  blocks: Block[];
}

export interface ConversationMeta {
  origin: Origin;
  /** the source harness's own session id, verbatim */
  sourceId: string;
  /** the project (workspace) name shown in that harness */
  projectName: string;
  /** the harness's own project id, when it has a real project registry */
  projectId?: string;
  /** absolute working directory of the session */
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** absolute path of the file this meta was read from */
  path: string;
}

export interface Conversation extends ConversationMeta {
  messages: Message[];
}

/** A read adapter turns one harness's on-disk store into IR. */
export interface Reader {
  readonly origin: Origin;
  list(): Promise<ConversationMeta[]>;
  read(sourceId: string): Promise<Conversation>;
}

export function textMessage(id: string, role: Role, text: string, time?: number): Message {
  return { id, role, time, blocks: [{ type: 'text', text }] };
}

export function isBlank(message: Message): boolean {
  return message.blocks.every((block) =>
    block.type === 'text' || block.type === 'reasoning' ? block.text.trim() === '' : false,
  );
}

export function messageText(message: Message): string {
  return message.blocks
    .filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Title convention shared by the writers when a source has no explicit title. */
export function deriveTitle(messages: Message[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return 'Untitled';
}

export function summarizeBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return `text(${block.text.length})`;
        case 'reasoning':
          return `reasoning(${block.text.length})`;
        case 'toolCall':
          return `call:${block.name}`;
        case 'toolResult':
          return `result(${block.output.length}, images:${block.images?.length ?? 0})`;
        case 'image':
          return `image:${block.mime}`;
      }
    })
    .join(' ');
}

/**
 * One message per block.
 *
 * Harnesses disagree about grouping: DSH emits a text event plus a
 * separate `tool/call` event, Codex emits one `response_item` per item, and
 * Claude packs text + `tool_use` into one row. Mirroring the native grouping
 * would make replicas differ forever, so every writer and every diff
 * runs on this canonical shape. Order, timestamps and content are preserved.
 */
export function canonicalize(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.blocks.length <= 1) {
      out.push(message);
      continue;
    }
    message.blocks.forEach((block, index) => {
      out.push({
        id: `${message.id}#${index}`,
        role: message.role,
        time: message.time,
        blocks: [block],
      });
    });
  }
  return out;
}
