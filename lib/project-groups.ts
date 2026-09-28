import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export interface RecentProject {
  /** Stable server-provided identity used for comparison and Map keys. */
  key: string;
  /** Original project path used for display and filesystem operations. */
  root: string;
  /** True when the entry comes from the user's pinned list rather than session history. */
  pinned?: boolean;
}

/** A user-pinned project directory, persisted client-side (e.g. localStorage). */
export interface PinnedProject {
  key: string;
  root: string;
}

/**
 * Merge pinned directories ahead of session-derived projects, deduplicated by
 * stable key. Pinned projects survive even after all of their sessions are
 * deleted, so the project list behaves like a persistent project registry
 * (Codex-style) instead of being purely derived from session history.
 */
export function mergePinnedProjects(
  recent: readonly RecentProject[],
  pinned: readonly PinnedProject[],
): RecentProject[] {
  const seen = new Set<string>();
  const merged: RecentProject[] = [];
  for (const p of pinned) {
    if (!p.key || seen.has(p.key)) continue;
    seen.add(p.key);
    merged.push({ key: p.key, root: p.root, pinned: true });
  }
  for (const r of recent) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    merged.push(r);
  }
  return merged;
}

/** Projects sorted by most recent activity and deduplicated by stable key. */
export function getRecentProjects(sessions: readonly SessionInfo[]): RecentProject[] {
  const latestByProject = new Map<string, { root: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, modified: session.modified });
    }
  }
  return [...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root }]) => ({ key, root }));
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (runningSessionIds.has(session.id)) entry.running++;
    if (unreadSessionIds.has(session.id)) entry.unread++;
  }
  return counts;
}

export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectKey: string,
): SessionInfo[] {
  return sessions.filter((session) => workspaceKeyOf(session) === projectKey);
}
