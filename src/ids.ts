import crypto from 'node:crypto';

import type { Message } from './ir.ts';
import { sha256 } from './attachments.ts';

/** RFC 4122 v5 (name-based, SHA-1) UUID — deterministic ids the targets accept as native ids. */
export function uuidV5(name: string, namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Content fingerprint used to diff replicas.
 *
 * The three harnesses re-mint their own item ids, so id equality cannot survive a
 * round trip. A fingerprint over role + observable content can, which makes the
 * mirror idempotent without relying on any one store's id scheme.
 */
export function messageFingerprint(message: Message): string {
  const parts: string[] = [message.role];
  for (const block of message.blocks) {
    switch (block.type) {
      case 'text':
        parts.push(`t:${normalize(block.text)}`);
        break;
      case 'reasoning':
        parts.push(`r:${normalize(block.text)}`);
        break;
      case 'toolCall':
        // Tool arguments are JSON that each harness may re-serialize with
        // different spacing or key order. Compare their canonical form, not
        // their bytes, or every round trip would look like a content change.
        parts.push(`c:${block.name}:${canonicalJson(block.input)}`);
        break;
      case 'toolResult':
        parts.push(`o:${normalize(block.output)}`);
        for (const image of block.images ?? []) {
          parts.push(`oi:${image.mime}:${image.data ? sha256(image.data) : image.ref.slice(0, 64)}`);
        }
        break;
      case 'image':
        // Two replicas may reference the same image differently (a DSH object id
        // versus an inline data URL); the bytes are what must match.
        parts.push(`i:${block.mime}:${block.data ? sha256(block.data) : block.ref.slice(0, 64)}`);
        break;
    }
  }
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
}

/**
 * Stable JSON text for comparison: parsed, key-sorted, whitespace-free.
 *
 * A harness that cannot store a raw string wraps it as `{ raw: text }`; unwrapping
 * here keeps the fingerprint over what the tool actually received, so a wrapped and
 * an unwrapped copy of the same call compare equal.
 */
function canonicalJson(text: string): string {
  try {
    let value: unknown = JSON.parse(text);
    if (isRawWrapper(value)) value = value.raw;
    if (typeof value === 'string') return canonicalJson(value);
    return JSON.stringify(sortKeys(value));
  } catch {
    return normalize(text);
  }
}

function isRawWrapper(value: unknown): value is { raw: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'raw' && typeof (value as { raw?: unknown }).raw === 'string';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** Multiset of fingerprints — order-insensitive, duplicate-preserving. */
export function fingerprintCounts(messages: Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = messageFingerprint(message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Messages that a replica is missing, in source order, honouring duplicates:
 * a target holding two copies of a fingerprint needs no third.
 */
export function missingMessages(target: Message[], source: Message[]): Message[] {
  const available = fingerprintCounts(target);
  const out: Message[] = [];
  for (const message of source) {
    const key = messageFingerprint(message);
    const left = available.get(key) ?? 0;
    if (left > 0) {
      available.set(key, left - 1);
      continue;
    }
    out.push(message);
  }
  return out;
}
