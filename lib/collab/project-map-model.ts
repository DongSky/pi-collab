import { overlappingPaths, type WorkDeclaration } from "./work-intent-schema";

export type MapDependency = { task_id: string; depends_on: string; kind: string };
export type MapTask = {
  id: string; title: string; status: string; owner_id: string; owner_name: string; owner_active: boolean;
  run: null | { id: string; status: string; dependency_state: string; started_at: string | null; created_at: string;
    requested_by: string; requested_name: string; workspace_status: string; repository_id: string; repository_name: string;
    execution_kind?: "ai" | "terminal"; model_name: string | null; model_id: string | null; controller?: { controllerName: string } };
  intent: WorkDeclaration | null;
  result: null | { id: string; version: number; current: boolean };
  resources: { id: string; status: string; names: string[] }[];
};
export type MapConflict = { left: string; right: string; paths: { ours: string; theirs: string }[]; pathCount: number; symbols: string[] };
export type ProjectMapData = {
  tasks: MapTask[]; dependencies: MapDependency[]; conflicts: MapConflict[]; conflictsLimited: boolean; capturedAt: string;
};
export const activeRunStates = new Set(["queued", "starting", "running", "waiting_input", "stopping", "reconciling"]);
export const terminalTaskStates = new Set(["done", "cancelled"]);

/** Longest dependency depth; preserves disconnected tasks and reports corrupt cycles. */
export function dependencyLayers(tasks: Pick<MapTask, "id">[], edges: MapDependency[]) {
  const ids = new Set(tasks.map(t => t.id)), depths = new Map<string, number>(), degree = new Map(tasks.map(t => [t.id, 0]));
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.task_id) || !ids.has(edge.depends_on)) continue;
    degree.set(edge.task_id, degree.get(edge.task_id)! + 1);
    children.set(edge.depends_on, [...(children.get(edge.depends_on) ?? []), edge.task_id]);
  }
  const queue = tasks.filter(t => degree.get(t.id) === 0).map(t => t.id);
  for (const id of queue) depths.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const child of children.get(id) ?? []) {
      depths.set(child, Math.max(depths.get(child) ?? 0, depths.get(id)! + 1));
      degree.set(child, degree.get(child)! - 1);
      if (!degree.get(child)) queue.push(child);
    }
  }
  const unresolved = tasks.filter(t => degree.get(t.id)! > 0).map(t => t.id);
  for (const id of unresolved) depths.delete(id);
  return { depths, unresolved };
}

export function mapConflicts(tasks: MapTask[]) {
  // Bound quadratic comparisons. Active runs take priority; disclose partial coverage.
  const candidates = tasks.filter(t => !terminalTaskStates.has(t.status) && t.run && t.intent)
    .sort((a, b) => Number(activeRunStates.has(b.run!.status)) - Number(activeRunStates.has(a.run!.status)) || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, 200), conflicts: MapConflict[] = [];
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const left = selected[i], right = selected[j];
    if (left.run!.repository_id !== right.run!.repository_id) continue;
    const paths = overlappingPaths(left.intent!.paths, right.intent!.paths);
    const symbols = left.intent!.symbols.filter(symbol => right.intent!.symbols.includes(symbol));
    if (paths.length || symbols.length) conflicts.push({ left: left.id, right: right.id, paths: paths.slice(0, 8), pathCount: paths.length, symbols });
  }
  return { conflicts, conflictsLimited: candidates.length > 200 };
}

export function taskAttention(task: MapTask, tasks: MapTask[], dependencies: MapDependency[]) {
  if (terminalTaskStates.has(task.status)) return [];
  const messages: string[] = [];
  if (!task.owner_active) messages.push("负责人权限已停用");
  if (task.status === "blocked") messages.push("任务已标记阻塞");
  if (task.run?.status === "failed") messages.push("最近运行失败");
  if (task.run?.status === "reconciling" || task.run?.workspace_status === "quarantined") messages.push("运行等待核查");
  if (task.run?.status === "waiting_input") messages.push("AI 等待输入");
  if (task.run?.dependency_state === "needs_revalidation") messages.push("依赖或契约已变化，需重新验证");
  if (task.run?.dependency_state === "untracked") messages.push("旧运行未跟踪依赖版本");
  const upstream = new Map(tasks.map(t => [t.id, t]));
  const missing = dependencies.filter(d => d.task_id === task.id && d.kind === "strict" && !upstream.get(d.depends_on)?.result?.current);
  if (missing.length) messages.push(`等待 ${missing.length} 项有效上游成果`);
  if (task.resources.some(r => r.status === "waiting")) messages.push("等待共享资源");
  return messages;
}
