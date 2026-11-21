/**
 * One writer per mirror group at a time.
 *
 * A group can be touched from three places that do not know about each other:
 * the 60s realtime pass, a button in the page, and the CLI. Two of them reading
 * the same target and appending the same delta would duplicate messages, so the
 * group is serialised twice:
 *
 *  - in-process: a promise chain, so two requests in this server queue up;
 *  - cross-process: an exclusive lock file, so `src/cli.ts sync` cannot race the
 *    running server. Dead process locks are removed immediately; an aged lock
 *    with an unknown owner is removed after `STALE_MS`. Live owners are never
 *    displaced just because a large sync runs longer than the age threshold.
 *
 * A crashed writer's PID lets the next caller release the lock immediately.
 * Waiting is bounded; if a healthy writer holds it, callers get a clear error
 * instead of writing concurrently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A large append can legitimately run for a couple of minutes; taking over a
// live lock would be worse than waiting.
const STALE_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const chains = new Map<string, Promise<void>>();

function lockDir(): string {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'migration-ledgers', '.locks');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock<T>(groupId: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const dir = lockDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${groupId}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      const handle = fs.openSync(file, 'wx');
      fs.writeSync(handle, `${process.pid}\n`);
      fs.closeSync(handle);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(file);
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        let ownerAlive = false;
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            ownerAlive = true;
          } catch (ownerError) {
            // EPERM still means the process exists; only ESRCH proves it is dead.
            ownerAlive = (ownerError as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
        const ownerKnownDead = Number.isInteger(pid) && pid > 0 && !ownerAlive;
        const ownerUnknownAndStale = !(Number.isInteger(pid) && pid > 0) && Date.now() - stat.mtimeMs > STALE_MS;
        if (ownerKnownDead || ownerUnknownAndStale) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {
        // the holder removed it between open and stat: retry immediately
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error('另一个同步正在进行，请稍后再试');
      }
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // a missing lock file is already released
    }
  }
}

export async function withGroupLock<T>(
  groupId: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const previous = chains.get(groupId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  chains.set(groupId, queued);
  await previous.catch(() => undefined);
  try {
    return await withFileLock(groupId, fn, timeoutMs);
  } finally {
    release();
    if (chains.get(groupId) === queued) chains.delete(groupId);
  }
}

/**
 * Removes locks left by processes that no longer exist.
 *
 * A killed server can leave a lock behind; waiting the full STALE_MS would make
 * that group look busy for minutes. Run at startup, before any pass.
 */
export function releaseDeadLocks(): number {
  const dir = lockDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(dir, name);
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      continue;
    }
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch {
      try {
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch {
        // someone else cleaned it up first
      }
    }
  }
  return removed;
}
