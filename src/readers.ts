import type { Origin, Reader } from './ir.ts';
import { ClaudeReader } from './adapters/claude.ts';
import { CodexReader } from './adapters/codex.ts';
import { DshReader } from './adapters/dsh.ts';
import { KimiReader } from './adapters/kimi.ts';
import { ZcodeReader } from './adapters/zcode.ts';

export function readerFor(origin: Origin): Reader {
  switch (origin) {
    case 'codex': return new CodexReader();
    case 'claude': return new ClaudeReader();
    case 'dsh': return new DshReader();
    case 'kimi': return new KimiReader();
    case 'zcode': return new ZcodeReader();
  }
}
