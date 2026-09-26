"use client";
import { useEffect, useMemo, useState } from "react";
import { collabApi, CollabApiError } from "./api";
import { activeRunStates, dependencyLayers, taskAttention, terminalTaskStates, type MapTask, type ProjectMapData } from "@/lib/collab/project-map-model";

const runNames: Record<string, string> = { queued: "排队中", starting: "启动中", running: "正在运行", waiting_input: "等待输入", stopping: "停止中", completed: "运行完成", failed: "运行失败", cancelled: "运行已取消", reconciling: "等待核查" };
const taskNames: Record<string, string> = { draft: "草稿", ready: "待开始", in_progress: "进行中", in_review: "评审中", ready_to_merge: "待合并", done: "已完成", blocked: "阻塞", cancelled: "已取消" };
type Filter = "all" | "active" | "attention" | "conflicts";

export function ProjectMap({ projectId, userId, onOpenTask }: { projectId: string; userId: string; onOpenTask: (id: string) => void }) {
  const [data, setData] = useState<ProjectMapData | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState<"dependency" | "owner">("dependency");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false, pending = false, denied = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function load() {
      if (disposed || pending || denied || document.hidden) return;
      clearTimeout(timer); pending = true;
      try {
        const next = await collabApi<ProjectMapData>(`projects/${projectId}/map`, undefined, undefined, controller.signal);
        if (!disposed) { setData(next); setError(""); }
      } catch (e) {
        if (!disposed) {
          setData(null);
          denied = e instanceof CollabApiError && [401, 403, 404].includes(e.status);
          setError(denied ? "项目访问权限已失效，请返回项目列表。" : "暂时无法读取全景，正在重试。也可以手动刷新。");
        }
      } finally {
        pending = false;
        if (!disposed && !denied) timer = setTimeout(() => void load(), 5000);
      }
    }
    const resume = () => { if (!document.hidden) void load(); };
    void load(); document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [projectId, refresh]);

  const derived = useMemo(() => {
    if (!data) return null;
    const attention = new Map(data.tasks.map(t => [t.id, taskAttention(t, data.tasks, data.dependencies)]));
    const conflicts = new Set(data.conflicts.flatMap(c => [c.left, c.right]));
    return { attention, conflicts, ...dependencyLayers(data.tasks, data.dependencies) };
  }, [data]);
  const picked = data?.tasks.find(t => t.id === selected);
  const owners = [...new Map(data?.tasks.map(t => [t.owner_id, t.owner_name])).entries()];
  const visible = data?.tasks.filter(t => (!owner || t.owner_id === owner)
    && `${t.title} ${t.owner_name} ${t.run?.model_name ?? ""} ${t.run?.model_id ?? ""} ${t.intent?.paths.join(" ") ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    && (filter === "all" || filter === "active" && t.run && activeRunStates.has(t.run.status)
      || filter === "attention" && !!derived?.attention.get(t.id)?.length || filter === "conflicts" && derived?.conflicts.has(t.id))) ?? [];
  const lanes = new Map<string, { label: string; tasks: MapTask[]; order: number }>();
  for (const task of visible) {
    const depth = derived?.depths.get(task.id);
    const key = group === "owner" ? task.owner_id : depth === undefined ? "unresolved" : String(depth);
    if (!lanes.has(key)) lanes.set(key, { label: group === "owner" ? task.owner_name : depth === undefined ? "依赖待核查" : depth === 0 ? "起点 · 可独立拆分" : `第 ${depth + 1} 层 · 依赖上游`, tasks: [], order: depth ?? Number.MAX_SAFE_INTEGER });
    lanes.get(key)!.tasks.push(task);
  }
  const upstream = data?.dependencies.filter(d => d.task_id === picked?.id) ?? [];
  const downstream = data?.dependencies.filter(d => d.depends_on === picked?.id) ?? [];
  const related = new Set([...upstream.map(d => d.depends_on), ...downstream.map(d => d.task_id)]);
  const link = (id: string) => <button type="button" className="collab-text-button" onClick={() => setSelected(id)}>{data?.tasks.find(t => t.id === id)?.title ?? "不可用任务"}</button>;

  return <section className="collab-map" aria-label="任务与 AI 全景">
    <div className="collab-section-heading"><div><h2>任务与 AI 全景</h2><p className="collab-muted collab-small">按依赖拆分工作，查看每位成员的 AI、等待原因与协作范围。</p></div><button className="collab-button" onClick={() => setRefresh(n => n + 1)}>刷新全景</button></div>
    {error && <p role="alert" className="collab-error">{error}</p>}
    {!error && !data && <p role="status">正在读取项目全景…</p>}
    {data && derived && <>
      <div className="collab-map-metrics" aria-label="项目实时概况">
        <div><strong>{data.tasks.filter(t => !terminalTaskStates.has(t.status)).length}</strong><span>未完成任务</span></div>
        <div><strong>{data.tasks.filter(t => t.run && t.run.execution_kind!=="terminal" && ["starting", "running", "waiting_input", "stopping"].includes(t.run.status)).length}</strong><span>活动 AI</span></div>
        <div><strong>{data.tasks.filter(t => t.run?.status === "queued").length}</strong><span>排队运行</span></div>
        <div><strong>{[...derived.attention.values()].filter(a => a.length).length}</strong><span>需要关注</span></div>
        <div><strong>{data.conflicts.length}</strong><span>范围重叠组合</span></div>
      </div>
      <form className="collab-map-controls" onSubmit={e => e.preventDefault()}>
        <label>搜索任务<input aria-label="搜索任务" value={search} onChange={e => setSearch(e.target.value)} placeholder="任务、成员、模型或路径" /></label>
        <label>负责人<select aria-label="负责人" value={owner} onChange={e => setOwner(e.target.value)}><option value="">所有成员</option>{owners.map(([id, name]) => <option value={id} key={id}>{name}{id === userId ? "（我）" : ""}</option>)}</select></label>
        <label>关注范围<select aria-label="关注范围" value={filter} onChange={e => setFilter(e.target.value as Filter)}><option value="all">全部任务</option><option value="active">活动与排队运行</option><option value="attention">需要关注</option><option value="conflicts">范围重叠</option></select></label>
        <label>排列方式<select aria-label="排列方式" value={group} onChange={e => setGroup(e.target.value as typeof group)}><option value="dependency">依赖层级</option><option value="owner">按成员</option></select></label>
      </form>
      <p className="collab-muted collab-small">显示 {visible.length} / {data.tasks.length} 项 · 最近读取 {new Date(data.capturedAt).toLocaleTimeString()} · 页面可见时每 5 秒更新</p>
      {derived.unresolved.length > 0 && <p role="alert">有 {derived.unresolved.length} 项任务的依赖不能分层，请检查依赖关系。</p>}
      {data.conflictsLimited && <p role="alert">范围检查仅覆盖优先选取的 200 项已声明任务；未列出重叠不代表其他任务没有冲突。</p>}
      <div className="collab-map-layout">
        <div className="collab-map-lanes">
          {!visible.length && <p className="collab-muted">{data.tasks.length ? "没有符合筛选条件的任务。" : "创建任务后，在这里查看协作全景。"}</p>}
          {[...lanes.entries()].sort((a, b) => group === "dependency" ? a[1].order - b[1].order : a[1].label.localeCompare(b[1].label)).map(([key, lane]) => <section className="collab-map-lane" key={key}>
            <h3>{lane.label}<span>{lane.tasks.length}</span></h3>
            {lane.tasks.map(t => <button type="button" key={t.id} className={`collab-map-card ${selected === t.id ? "selected" : ""} ${related.has(t.id) ? "related" : ""}`}
              aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}>
              <span className="collab-map-card-top"><span>{t.owner_name}</span><span>{taskNames[t.status] ?? t.status}</span></span>
              <strong>{t.title}</strong>
              <span className={`collab-map-run ${t.run && activeRunStates.has(t.run.status) ? "active" : ""}`}>{t.run ? (t.run.execution_kind==="terminal"?"人工终端 · ":"")+(runNames[t.run.status] ?? t.run.status) : "尚未启动 AI"}</span>
              {t.run?.controller && <small>控制者：{t.run.controller.controllerName}</small>}
              {t.run && <small>{t.run.model_name ?? "未使用模型"}{t.run.model_id ? ` · ${t.run.model_id}` : ""}</small>}
              {!!derived.attention.get(t.id)?.length && <span className="collab-map-warning">{derived.attention.get(t.id)![0]}</span>}
              {derived.conflicts.has(t.id) && <span className="collab-map-warning">与其他任务范围重叠</span>}
              {t.result?.current && <small>有效成果 v{t.result.version}</small>}
            </button>)}
          </section>)}
        </div>
        <aside className="collab-map-inspector" aria-label="全景任务详情">
          {picked ? <>
            <h3>{picked.title}</h3><p className="collab-small">负责人：{picked.owner_name}</p>
            <button className="collab-button primary" onClick={() => onOpenTask(picked.id)}>打开任务与运行</button>
            {picked.run && <><h4>{picked.run.execution_kind==="terminal"?"当前人工终端":"当前 AI"}</h4><p>{runNames[picked.run.status]} · {picked.run.requested_name} 发起</p><p>{picked.run.repository_name} · {picked.run.model_name ?? "未使用模型"}</p><small>运行 {picked.run.id.slice(0, 8)} · {new Date(picked.run.started_at ?? picked.run.created_at).toLocaleString()}</small></>}
            {derived.attention.get(picked.id)!.length > 0 && <><h4>需要关注</h4><ul>{derived.attention.get(picked.id)!.map(text => <li key={text}>{text}</li>)}</ul></>}
            <h4>前置任务</h4>{upstream.length ? upstream.map(d => <p key={d.depends_on}>{link(d.depends_on)}<small>{d.kind === "strict" ? "严格依赖 · 需要有效成果" : "软依赖 · 可先按约定开发"}</small></p>) : <p>没有前置依赖</p>}
            <h4>影响的下游</h4>{downstream.length ? downstream.map(d => <p key={d.task_id}>{link(d.task_id)}<small>{d.kind === "strict" ? "严格依赖" : "软依赖"}</small></p>) : <p>没有直接下游</p>}
            <h4>声明的修改范围</h4>{picked.intent ? <><p>{picked.intent.summary}</p><ul>{picked.intent.paths.map(p => <li key={p}><code>{p}</code></li>)}</ul>{picked.intent.symbols.length > 0 && <p>接口／符号：{picked.intent.symbols.join("、")}</p>}</> : <p>当前运行未声明范围，不能据此判断是否存在重叠。</p>}
            {data.conflicts.filter(c => c.left === picked.id || c.right === picked.id).map(c => <div className="collab-map-overlap" key={`${c.left}:${c.right}`}>
              <strong>重叠任务：{link(c.left === picked.id ? c.right : c.left)}</strong>
              <ul>{c.paths.map((p, i) => <li key={i}><code>{p.ours} ↔ {p.theirs}</code></li>)}</ul>
              {c.pathCount > c.paths.length && <small>共 {c.pathCount} 组路径重叠，展示前 {c.paths.length} 组。</small>}
              {c.symbols.length > 0 && <p>共同符号：{c.symbols.join("、")}</p>}
            </div>)}
            {picked.resources.length > 0 && <><h4>共享资源</h4>{picked.resources.map(r => <p key={r.id}>{r.names.join("、")}<small>{({ waiting: "等待分配", granted: "持有中", releasing: "释放中" } as Record<string, string>)[r.status]}</small></p>)}</>}
          </> : <><h3>选择任务查看协作关系</h3><p>点击卡片查看上游、下游、运行和范围重叠，再进入任务处理。</p></>}
          <p className="collab-muted collab-small">依赖层级不表示已获准执行；运行完成也不代表任务已交付。范围提示来自声明，实际代码冲突仍须通过整合验证。</p>
        </aside>
      </div>
    </>}
  </section>;
}
