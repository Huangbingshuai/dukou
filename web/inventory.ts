/**
 * The conversation inventory: every store listed, grouped by mirror ledger, and
 * filed into each tool's own projects. Reads a lot of files and sqlite rows, so it
 * runs in the sync worker; the HTTP layer only serialises the result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Origin } from '../src/ir.ts';
import { Ledger } from '../src/ledger.ts';
import { HARNESSES, HARNESS_IDS } from '../src/registry.ts';
import { readerFor } from '../src/readers.ts';

const ORIGINS: Origin[] = HARNESS_IDS;
const LABELS: Record<string, string> = Object.fromEntries(HARNESSES.map((harness) => [harness.id, harness.label]));

export interface SessionRow {
  origin: Origin;
  id: string;
  title: string;
  project: string;
  cwd: string;
  updatedAt: number;
  archived: boolean;
}

/**
 * One row per *conversation*, not per stored session.
 *
 * A conversation is a ledger group plus every session that is not in one. The
 * page shows three harness chips per row, so "where does this exist" is answered
 * by the row itself instead of by decoding a table.
 */
export interface ConversationRow {
  key: string;
  title: string;
  project: string;
  cwd: string;
  updatedAt: number;
  replicas: Partial<Record<Origin, { id: string; archived: boolean }>>;
  /** native project id per harness, so the tree can use each tool's own grouping */
  projects: Partial<Record<Origin, string>>;
  aligned: boolean;
}

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

/**
 * Each tool's own project list, in its own order.
 *
 * The tree must match what the tool itself shows: Codex keeps a `projects` table
 * with a user-defined order, DeepSeek Harness keeps workspaces, and Claude Code
 * only has directories.
 */
export function nativeProjects(origin: Origin): ProjectRow[] {
  if (origin === 'codex') {
    // The desktop app's own project list lives in the global state file; the
    // `projects` table is the runtime's, and it can lag behind it.
    const desktop = codexDesktopProjects();
    if (desktop.length > 0) return desktop;

    const db = openCodexReadOnly();
    if (!db) return [];
    try {
      const rows = db.prepare('select id, name from projects order by position asc, id asc').all() as Array<{
        id: string;
        name: string;
      }>;
      const roots = db
        .prepare('select project_id, path from project_roots order by project_id, position asc')
        .all() as Array<{ project_id: string; path: string }>;
      const firstRoot = new Map<string, string>();
      for (const root of roots) if (!firstRoot.has(root.project_id)) firstRoot.set(root.project_id, root.path);
      return rows.map((row) => ({ id: row.id, name: row.name, path: firstRoot.get(row.id) ?? '' }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  if (origin === 'dsh') {
    try {
      const raw = fs.readFileSync(path.join(process.env.HOME ?? '', '.dsh', 'storages', 'workspace.json'), 'utf8');
      const payload = JSON.parse(raw) as {
        tables?: { workspaces?: Record<string, { title?: string; path?: string; createdAt?: string }> };
        global?: { workspaceIds?: string[] };
      };
      // The sidebar reads `global.workspaceIds`: that is the order the user sees,
      // and it is not creation order (a workspace can be moved or re-created).
      const workspaces = payload.tables?.workspaces ?? {};
      const listed = payload.global?.workspaceIds ?? [];
      const rank = new Map(listed.map((id, index) => [id, index]));
      return Object.entries(workspaces)
        .sort((a, b) => {
          const ra = rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
          const rb = rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return (a[1].createdAt ?? '').localeCompare(b[1].createdAt ?? '');
        })
        .map(([id, entry]) => ({ id, name: entry.title ?? '', path: entry.path ?? '' }));
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Manual project assignments.
 *
 * Some threads carry no project at all: the Codex desktop keeps their assignment
 * server-side (`pendingThreadAssignmentIds` in its global state), so the link is
 * not on this disk. These overrides live in 渡口's own ledger and are applied on
 * top of whatever the store says.
 */
const OVERRIDES_FILE = path.join(
  process.env.HOME ?? '',
  '.dsh',
  'migration-ledgers',
  'dukou-projects.json',
);

export function loadOverrides(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

export function saveOverrides(data: Record<string, Record<string, string>>): void {
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Projects as the Codex desktop app lists them, in the user's own order.
 *
 * A project here can hold conversations that are not on this machine (the app
 * also shows cloud-backed threads), which is why a local count may be 0 while the
 * app shows something.
 */
export function codexDesktopProjects(): ProjectRow[] {
  const file = path.join(process.env.HOME ?? '', '.codex', '.codex-global-state.json');
  if (!fs.existsSync(file)) return [];
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      'local-projects'?: Record<string, { name?: string; rootPaths?: string[]; createdAt?: number }>;
      'project-order'?: string[];
    };
    // `project-order` is the desktop sidebar's order (the user can drag projects);
    // projects it does not list yet go after the listed ones, oldest first.
    const projects = state['local-projects'] ?? {};
    const rank = new Map((state['project-order'] ?? []).map((id, index) => [id, index]));
    return Object.entries(projects)
      .sort((a, b) => {
        const ra = rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0);
      })
      .map(([id, entry]) => ({ id, name: entry.name ?? '', path: entry.rootPaths?.[0] ?? '' }));
  } catch {
    return [];
  }
}

export function openCodexReadOnly(): import('node:sqlite').DatabaseSync | undefined {
  const file = path.join(process.env.HOME ?? '', '.codex', 'state_5.sqlite');
  if (!fs.existsSync(file)) return undefined;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

export async function listConversations(): Promise<{
  harnesses: typeof HARNESSES;
  summary: { total: number; aligned: number; single: number; partial: number; harnesses: number };
  conversations: ConversationRow[];
  errors: string[];
}> {
  const errors: string[] = [];
  const now = Date.now();

  // Read every store first: a mirror group can only be placed in a project once the
  // sessions (and their native project ids) are known.
  const byOrigin = new Map<Origin, Awaited<ReturnType<ReturnType<typeof readerFor>['list']>>>();
  await Promise.all(
    ORIGINS.map(async (origin) => {
      try {
        byOrigin.set(origin, await readerFor(origin).list());
      } catch (error) {
        errors.push(`${LABELS[origin]}: ${(error as Error).message}`);
        byOrigin.set(origin, []);
      }
    }),
  );

  const overrides = loadOverrides();
  const index = new Map<string, { projectId?: string; projectName?: string; cwd?: string }>();
  for (const [origin, rows] of byOrigin) {
    for (const row of rows) {
      index.set(`${origin}:${row.sourceId}`, {
        projectId: row.projectId,
        projectName: row.projectName,
        cwd: row.cwd,
      });
    }
  }

  // Codex has two project registries: the runtime's `projects` table (used for
  // `threads.project_id`) and the desktop app's `local-projects`. The sidebar the
  // reader compares against is the desktop one, so map onto its ids by name first,
  // then by folder.
  const codexProjects = nativeProjects('codex');
  const codexByName = new Map(codexProjects.map((project) => [project.name, project.id]));
  const codexByRoot = new Map(codexProjects.filter((p) => p.path).map((project) => [project.path, project.id]));
  const resolveCodexProject = (projectId?: string, projectName?: string, cwd?: string): string | undefined => {
    const byName = projectName ? codexByName.get(projectName) : undefined;
    if (byName) return byName;
    const byRoot = cwd ? codexByRoot.get(cwd) : undefined;
    if (byRoot) return byRoot;
    return projectId;
  };

  const conversations: ConversationRow[] = [];
  const covered = new Set<string>();
  const ledger = new Ledger();

  for (const record of ledger.all()) {
    const replicas: ConversationRow['replicas'] = {};
    const groupProjects: ConversationRow['projects'] = {};
    let activity = 0;
    for (const origin of ORIGINS) {
      const replica = record.replicas?.[origin];
      if (!replica?.sessionId) continue;
      replicas[origin] = { id: replica.sessionId, archived: false };
      covered.add(`${origin}:${replica.sessionId}`);
      const meta = index.get(`${origin}:${replica.sessionId}`);
      const forced = overrides[origin]?.[replica.sessionId];
      const nativeProject = forced ??
        (origin === 'codex'
          ? resolveCodexProject(meta?.projectId, meta?.projectName, meta?.cwd)
          : meta?.projectId);
      if (nativeProject) groupProjects[origin] = nativeProject;
      if (replica.path) {
        try {
          activity = Math.max(activity, fs.statSync(replica.path).mtimeMs);
        } catch {
          // a replica we cannot stat contributes nothing
        }
      }
    }
    const writablePresent = Object.keys(replicas).filter((origin) => HARNESSES.some((harness) => harness.id === origin && harness.canWrite)).length;
    // Order by the replicas' own file times, never by when our last pass ran.
    conversations.push({
      key: `group:${record.groupId}`,
      title: record.title,
      project: record.projectName,
      cwd: record.cwd,
      updatedAt: activity || record.updatedAt || now,
      replicas,
      projects: groupProjects,
      aligned: writablePresent === HARNESSES.filter((harness) => harness.canWrite).length,
    });
  }

  for (const [origin, rows] of byOrigin) {
    for (const row of rows) {
      if (covered.has(`${origin}:${row.sourceId}`)) continue;
      // Archived threads are behind a filter in their own app; the tree mirrors
      // the default view, so they do not get a row here either.
      if (row.archived) continue;
      conversations.push({
        key: `session:${origin}:${row.sourceId}`,
        title: row.title,
        project: row.projectName,
        cwd: row.cwd,
        updatedAt: row.updatedAt,
        replicas: { [origin]: { id: row.sourceId, archived: row.archived } },
        projects: (() => {
          const forced = overrides[origin]?.[row.sourceId];
          const id =
            forced ??
            (origin === 'codex'
              ? resolveCodexProject(row.projectId, row.projectName, row.cwd)
              : row.projectId);
          return id ? { [origin]: id } : {};
        })(),
        aligned: false,
      });
    }
  }

  // Deterministic order: newest activity first, ties broken by title so a refresh
  // with identical data can never shuffle the list.
  conversations.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  const writableCount = HARNESSES.filter((harness) => harness.canWrite).length;
  const aligned = conversations.filter((row) => Object.keys(row.replicas).filter((origin) => HARNESSES.some((h) => h.id === origin && h.canWrite)).length === writableCount).length;
  const single = conversations.filter((row) => Object.keys(row.replicas).length === 1).length;
  return {
    harnesses: HARNESSES,
    summary: {
      total: conversations.length,
      aligned,
      single,
      partial: conversations.length - aligned - single,
      harnesses: ORIGINS.length,
    },
    conversations,
    errors,
  };
}

export async function listSessions(filter: string): Promise<{ stores: Record<string, unknown>; sessions: SessionRow[]; errors: string[] }> {
  const stores: Record<string, unknown> = {};
  const sessions: SessionRow[] = [];
  const errors: string[] = [];
  const wanted = ORIGINS.filter((origin) => filter === 'all' || filter === origin);

  await Promise.all(
    wanted.map(async (origin) => {
      try {
        const rows = await readerFor(origin).list();
        stores[origin] = { count: rows.length, label: LABELS[origin] };
        for (const row of rows) {
          sessions.push({
            origin,
            id: row.sourceId,
            title: row.title,
            project: row.projectName,
            cwd: row.cwd,
            updatedAt: row.updatedAt,
            archived: row.archived,
          });
        }
      } catch (error) {
        stores[origin] = { count: 0, label: LABELS[origin], error: (error as Error).message };
        errors.push(`${LABELS[origin]}: ${(error as Error).message}`);
      }
    }),
  );

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { stores, sessions, errors };
}

