/**
 * Flattens one conversation into display lines.
 *
 * Runs in the sync worker: a 15k-message conversation takes over a second to read
 * and used to block every other HTTP request while the page loaded it. Images are
 * returned as bytes alongside the lines so the HTTP layer can keep serving
 * `/api/image/<hash>` from its own cache.
 */
import type { Origin } from '../src/ir.ts';
import { canonicalize } from '../src/ir.ts';
import { sha256 } from '../src/attachments.ts';
import { readerFor } from '../src/readers.ts';

export interface TranscriptLine {
  role: string;
  kind: 'text' | 'reasoning' | 'tool' | 'image';
  text: string;
  time?: number;
  /** for images: `/api/image/<sha256>` */
  src?: string;
  mime?: string;
}

export interface TranscriptImage {
  hash: string;
  mime: string;
  base64: string;
}

export async function buildTranscript(
  origin: Origin,
  id: string,
): Promise<{ lines: TranscriptLine[]; images: TranscriptImage[] }> {
  const conversation = await readerFor(origin).read(id);
  const messages = canonicalize(conversation.messages);
  const lines: TranscriptLine[] = [];
  const images = new Map<string, TranscriptImage>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        const text = block.text.trim();
        if (text) lines.push({ role: message.role, kind: 'text', text: text.slice(0, 20000), time: message.time });
      } else if (block.type === 'reasoning') {
        const text = block.text.trim();
        if (text) lines.push({ role: 'assistant', kind: 'reasoning', text: text.slice(0, 1200), time: message.time });
      } else if (block.type === 'toolCall') {
        lines.push({
          role: 'assistant',
          kind: 'tool',
          text: `${block.name} ${block.input}`.slice(0, 400),
          time: message.time,
        });
      } else if (block.type === 'toolResult') {
        lines.push({ role: 'tool', kind: 'tool', text: block.output.slice(0, 400), time: message.time });
        for (const image of block.images ?? []) {
          if (image.data) {
            const hash = sha256(image.data);
            if (!images.has(hash)) images.set(hash, { hash, mime: image.mime, base64: image.data });
            lines.push({
              role: 'tool',
              kind: 'image',
              text: '',
              mime: image.mime,
              src: `/api/image/${hash}`,
              time: message.time,
            });
          } else {
            lines.push({ role: 'tool', kind: 'tool', text: `[工具结果图片 ${image.mime}]`, time: message.time });
          }
        }
      } else if (block.type === 'image') {
        if (block.data) {
          const hash = sha256(block.data);
          if (!images.has(hash)) images.set(hash, { hash, mime: block.mime, base64: block.data });
          lines.push({
            role: message.role,
            kind: 'image',
            text: '',
            mime: block.mime,
            src: `/api/image/${hash}`,
            time: message.time,
          });
        } else {
          lines.push({ role: message.role, kind: 'tool', text: `[图片 ${block.mime}]`, time: message.time });
        }
      }
    }
  }

  return { lines, images: [...images.values()] };
}
