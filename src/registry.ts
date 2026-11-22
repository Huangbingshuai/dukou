import type { Origin } from './ir.ts';

/**
 * The harness registry.
 *
 * This is the one place that knows which tools take part, what to call them, and
 * how to color them. Adding a harness means: write an adapter + a writer, extend
 * the `Origin` union in `ir.ts`, and add one entry here. The web UI renders its
 * chips from this list, so it never has to change.
 */
export interface Harness {
  id: Origin;
  /** Shown in the UI. */
  label: string;
  /** Two-letter mark for tight spaces. */
  short: string;
  /** Chip color; only used as a visual identity, never as the sole signal. */
  color: string;
  /** Where this harness keeps its conversations, for the detail line. */
  store: string;
  /** Whether this tool has a verified, safe conversation writer. */
  canWrite: boolean;
}

export const HARNESSES: Harness[] = [
  // `label` is the coding tool's own name, not the vendor or the model family.
  { id: 'codex', label: 'Codex', short: 'CX', color: '#111111', store: '~/.codex', canWrite: true },
  { id: 'claude', label: 'Claude Code', short: 'CL', color: '#d97757', store: '~/.claude', canWrite: true },
  { id: 'dsh', label: 'DeepSeek Harness', short: 'DSH', color: '#4d6bfe', store: '~/.dsh', canWrite: true },
  { id: 'kimi', label: 'Kimi Code', short: 'KI', color: '#7357ff', store: '~/.kimi-code', canWrite: false },
  { id: 'zcode', label: 'ZCode', short: 'ZC', color: '#11a37f', store: '~/.zcode', canWrite: true },
];

export const HARNESS_IDS: Origin[] = HARNESSES.map((harness) => harness.id);

export function harnessOf(id: string): Harness | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
