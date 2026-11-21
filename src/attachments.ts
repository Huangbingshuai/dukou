import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Image bytes, moved rather than referenced.
 *
 * Claude and Codex both carry an image as an inline base64 data URL; DSH stores it
 * once in a content-addressed object store and references it as `sha256:<hash>`.
 * The IR therefore keeps the base64 payload, and only the DSH side needs the
 * object store.
 */

const DSH_OBJECT_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'attachments', 'v1', 'objects')
  : path.join(process.env.HOME ?? '', '.dsh', 'attachments', 'v1', 'objects');

export interface ImageAsset {
  mime: string;
  /** base64 without the data-url prefix */
  base64: string;
  name?: string;
}

export function sha256(base64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

export function dshObjectPath(id: string): string {
  const hash = id.replace(/^sha256:/, '');
  return path.join(DSH_OBJECT_ROOT, hash.slice(0, 2), hash);
}

/** Reads a DSH attachment object back into an asset, or nothing when it is gone. */
export function readDshImage(id: string, mime: string, name?: string): ImageAsset | undefined {
  const file = dshObjectPath(id);
  try {
    return { mime, base64: fs.readFileSync(file).toString('base64'), name };
  } catch {
    return undefined;
  }
}

/**
 * Stores bytes in the DSH object store and returns the reference DSH writes.
 * Content addressing makes this idempotent: the same image is stored once.
 */
export function writeDshImage(asset: ImageAsset): string {
  const hash = sha256(asset.base64);
  const file = dshObjectPath(`sha256:${hash}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.session-mirror.tmp`;
    fs.writeFileSync(temp, Buffer.from(asset.base64, 'base64'));
    fs.renameSync(temp, file);
  }
  return `sha256:${hash}`;
}

export function toDataUrl(asset: ImageAsset): string {
  return `data:${asset.mime};base64,${asset.base64}`;
}

/** Parses `data:<mime>;base64,<payload>` (Codex and Claude both use it). */
export function fromDataUrl(url: string): ImageAsset | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url.trim());
  if (!match) return undefined;
  return { mime: match[1], base64: match[2] };
}

/** Best-effort width/height, so the DSH block carries the same facts as a native one. */
export function imageSize(base64: string): { width: number; height: number } | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return undefined;
  }
  if (bytes.length > 24 && bytes.toString('latin1', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

export function byteLength(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}
