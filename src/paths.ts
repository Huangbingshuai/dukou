import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HOME, '.codex');
export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(HOME, '.claude');
export const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh');

/** `claude` encodes a cwd by replacing every separator with '-'. */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}

/**
 * DSH encodes project paths as readable filesystem keys. Separators collapse
 * to '-', while unsafe UTF-16 code units are escaped as `~XXXX`.
 */
export function encodeDshCwd(cwd: string): string {
  if (!cwd.length) throw new Error('cannot encode an empty project path');

  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }

  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function readFirstLine(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    fs.closeSync(fd);
  }
}

/** Bounded recursive file discovery; skips unreadable directories instead of failing. */
export function findFiles(root: string, accept: (file: string) => boolean): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && accept(full)) found.push(full);
    }
  }
  return found.sort();
}

export function readJsonLines(file: string): unknown[] {
  const text = fs.readFileSync(file, 'utf8');
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A truncated tail is normal for a session being written right now.
    }
  }
  return rows;
}

export function safeBasename(dir: string): string {
  return path.basename(dir) || dir;
}
