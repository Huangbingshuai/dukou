import { canonicalize } from './ir.ts';
import type { Origin } from './ir.ts';
import { ClaudeReader } from './adapters/claude.ts';
import { CodexReader } from './adapters/codex.ts';
import { DshReader } from './adapters/dsh.ts';

/**
 * Pre-flight check for a migration.
 *
 * Lives in its own module because the plugin entry is re-imported on every
 * reinstall while modules it already loaded stay cached; a guard the UI must
 * enforce cannot wait for an app restart.
 */
export async function assertMigratable(origin: Origin, sessionId: string): Promise<number> {
  const reader = origin === 'codex' ? new CodexReader() : origin === 'claude' ? new ClaudeReader() : new DshReader();
  const conversation = await reader.read(sessionId);
  const count = canonicalize(conversation.messages).length;
  if (count === 0) {
    throw new Error(`会话 ${origin}/${sessionId} 没有任何可迁移的消息（空会话），未做任何写入`);
  }
  return count;
}
