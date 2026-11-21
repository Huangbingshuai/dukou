import { fromDataUrl } from './attachments.ts';
import type { ImageBlock } from './ir.ts';

export interface DecodedToolOutput {
  text: string;
  images: ImageBlock[];
}

/**
 * Tool outputs have been serialized as strings, typed block arrays, and (in older
 * mirror transcripts) JSON text containing a typed block array. Normalize these
 * shapes without interpreting arbitrary JSON command output.
 */
export function decodeToolOutput(value: unknown): DecodedToolOutput {
  let blocks: unknown[] | undefined;
  if (Array.isArray(value)) blocks = value;
  else if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) blocks = parsed;
    } catch {
      // It is ordinary tool output, not serialized content blocks.
    }
  }
  if (!blocks) return { text: typeof value === 'string' ? value : JSON.stringify(value ?? ''), images: [] };

  const text: string[] = [];
  const images: ImageBlock[] = [];
  let recognized = true;
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') { recognized = false; continue; }
    const block = entry as Record<string, any>;
    if (['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string') {
      text.push(block.text);
    } else if (block.type === 'input_image' && typeof block.image_url === 'string') {
      const asset = fromDataUrl(block.image_url);
      if (asset) images.push({ type: 'image', mime: asset.mime, ref: '', data: asset.base64 });
      else recognized = false;
    } else if (block.type === 'image') {
      const source = block.source ?? {};
      if (typeof source.data === 'string') images.push({ type: 'image', mime: String(source.media_type ?? 'image/*'), ref: '', data: source.data });
      else recognized = false;
    } else recognized = false;
  }
  if (!recognized) return { text: typeof value === 'string' ? value : JSON.stringify(value), images: [] };
  return { text: text.join('\n'), images };
}
