"use client";
import { RunChatComposer } from "./RunChatComposer";
import { ChatMessage, ChatMessages } from "./ChatMessages";
import { chatRows } from "@/lib/collab/chat-transcript";
import { AiPanelTabs, type AiPanelTab } from "./AiPanelTabs";
import { readRunDraft, runDraftKeys, runComposerDraft, saveRunRequest } from "@/lib/collab/run-draft";
import { PanelResize, WorkbenchIcon, usePanelSize } from "./WorkbenchChrome";
import { Subtasks } from "./Subtasks";
import { SharedTerminal } from "./SharedTerminal";
import { AgentDock, useDesktopAgentDock, useFiles } from "./WorkspaceFiles";
import { TaskCodeWorkspace } from "./TaskCodeWorkspace";
import { TaskDiscussions } from "./TaskDiscussions";
import { Activity, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";
import { TaskSnapshots, type Snapshot } from "./TaskSnapshots";
import { TaskValidations } from "./TaskValidations";
import { TaskResults } from "./TaskResults";
import { WorkIntents } from "./WorkIntents";
import { TaskContracts } from "./TaskContracts";
import { TaskNotes } from "./TaskNotes";
import { ProjectResources } from "./ProjectResources";
import { ResolutionContext, type ResolutionInfo, type ResolutionMember } from "./ResolutionTasks";
import { CheckpointPreviews } from "./CheckpointPreviews";
import { ProjectMemory } from "./ProjectMemory";
import { GitLabPanel } from "./GitLabPanel";
import { GitHubImports } from "./GitHubImports";
import { GitHubRepositoryInfo, GitHubSyncs, type GitHubBindingSummary } from "./GitHubConnections";
import { ProjectIntegrations } from "./ProjectIntegrations";
import { WorkspaceGit } from "./WorkspaceGit";
import { TaskPushPreviews } from "./TaskPushPreviews";
import { RunControl, type ControlState } from "./RunControl";

type Revert = { promotion_id: string; repository_id: string; target_sha: string; old_sha: string; new_sha: string; current: boolean };
type Task = { id: string; title: string; description: string; acceptance: string; owner_id: string; version: number; status: string };
type Run = { repository_id?:string; execution_kind: "ai" | "terminal"; id: string; requested_by: string; prompt: string; status: string; revision: string; stop_reason: string | null; summary: { error?: string; reason?: string } | null; created_at: string; workspace_status: string; control: ControlState; latest_action: { id: string; kind: string; status: string; code: string | null } | null };
type Repository = { id: string; name: string; base_sha: string; default_branch: string; github?: GitHubBindingSummary | null };
type Model = { id: string; name: string; enabled: boolean; run_request_limit: number; run_token_limit: number };
type VisibleEvent = { type: string; text?: string; toolName?: string; isError?: boolean; message?: { role: string; content: { text?: string }[]; errorMessage?: string }; content?: { text?: string }[] };
type Batch = { sequence: string; payload: { events: VisibleEvent[] } };
type Start = { repositoryId?: string; workingDirectory?: string; baseSha?: string; prompt: string; expectedVersion: number; idempotencyKey: string; modelProfileId?: string; executionKind?: "ai" | "terminal"; snapshotId?: string; suggestionId?: string; editorVersionId?: string };
type RunAction = { action: "recover" | "archive"; reason: string; idempotencyKey: string; expectedRevision: string };
const names: Record<string, string> = { queued: "排队中", starting: "准备工作区", running: "AI 执行中", waiting_input: "等待输入", stopping: "正在停止", completed: "本次运行结束", failed: "运行失败", cancelled: "已停止", reconciling: "待对账 · 工作区已隔离" };
const terminal = new Set(["completed", "failed", "cancelled"]);
function failureExplanation(raw: string) {
  if (raw.includes("environment_runtime_mismatch")) return "当前执行器与交接来源的运行时指纹不同，尚未开始 AI 工作。请使用原版本 Node/Pi 工具链或从新基线建立环境。";
  if (raw.includes("environment_")) return "环境重建未完成，请核对固定配方、依赖锁文件及环境交接记录。";
  if (raw.includes("workspace_port_occupied")) return "工作区分配端口被本机其他进程占用，尚未启动 AI；请核对端口或重新创建运行。";
  if (raw.includes('"code":"model_money_exhausted"')) return "项目今日费用预算不足，请在资源与费用页核对预留与已知费用。";
  if (raw.includes('"code":"model_price_unknown"')) return "已启用费用预算，但模型价格或当天历史费用未知。请维护者核对资源与费用设置。";
  if (raw.includes('"code":"provider_rate_limited"')) return "模型服务当前限流或容量不足，本次运行未完成。稍后可重新启动；本次记录和工作区会保留。";
  if (raw.includes('"code":"provider_authentication_failed"')) return "模型服务拒绝了项目凭据，请联系维护者检查模型配置。";
  if (raw.includes('"code":"provider_unavailable"')) return "模型服务暂时不可用，本次运行未完成。稍后可重新启动。";
  if (raw.includes('"code":"model_access_denied"')) return "本次运行的模型访问授权已失效，请核对运行状态和项目权限；重新启用模型后需要新建运行。";
  return raw;
}
const limitReasons: Record<string, string> = { execution_timeout: "已到本次运行固定的时长上限，工作区保留。", workspace_storage_exhausted: "工作区超过本次运行固定的磁盘额度，写入进程已停止；文件保留，请在资源与费用页核对。", storage_measurement_unavailable: "暂时无法完整核验工作区用量，运行已停止，等待用量核查。" };
const explain: Record<string, string> = {
  queued: "等待执行名额、磁盘额度，以及严格前置依赖发布可消费的成果。", starting: "正在准备独立工作区和 AI 进程。",
  stopping: "停止请求已接纳，等待确认进程退出。", completed: "AI 已结束本次运行，变更仍需检查和评审。",
  reconciling: "上次操作结果尚不确定。维护者可申请核对旧进程；确认退出后才能解除阻塞。旧工作区保留，未知操作不会自动重试。",
};
const recoveryMessages: Record<string, string> = {
  writer_present: "旧进程或其子进程仍存在。请等待执行器停止它，再重新检查。",
  receipt_missing: "缺少进程启动记录，无法确认旧写入者退出。工作区继续隔离。",
  receipt_invalid: "进程记录无法验证，工作区继续隔离。",
  launch_uncertain: "启动中断，无法确定进程是否已创建。需要本机管理员进一步核查。",
  boot_changed: "执行节点启动标识已变化，无法据此判断原节点是否仍在运行。",
  inspection_unavailable: "暂时无法检查本机进程，请稍后重新检查。",
  unsupported_runtime: "该运行后端的退出对账尚未通过验证，工作区继续隔离。",
  authorization_changed: "申请人的权限已变化，请由当前项目维护者重新提交。",
  stop_confirmed: "执行器已记录进程退出。原命令的外部副作用仍需人工核对。",
  group_absent: "已确认旧进程及进程组不存在。原命令的外部副作用仍需人工核对。",
};

export function TaskRuns({ visible, task, tasks, projectId, userId, role, runtime, onChange, members, onOpenTask, initialThread, overview,codeRequest }: {visible:boolean;codeRequest:number; overview?: ReactNode; initialThread?: string | null; members: ResolutionMember[]; onOpenTask: (taskId: string) => Promise<void>; task: Task; tasks: { id: string; title: string }[]; projectId: string; userId: string; role: string; runtime: string; onChange: () => Promise<void> }) {
  const panels = [{id:"overview",label:"概览",icon:"tasks"},{id:"code",label:"代码 / 共编",icon:"code"},{id:"git",label:"Git 变更",icon:"git"},{id:"delivery",label:"验证 / 交付",icon:"check"},{id:"discussion",label:"讨论",icon:"team"},{id:"coordination",label:"协作约定",icon:"map"},{id:"preview",label:"预览 / 环境",icon:"panel"}] as const;
  type Panel = typeof panels[number]["id"];
  const [taskAiTab,setTaskAiTab]=useState<AiPanelTab>("chat"),taskAiTabId=useId();
  const [chosenPanel,setPanel]=useState<Panel>(initialThread?"discussion":"code"),[aiOpen,setAiOpen]=useState(true);
  const files=useFiles(),fileFocused=files.active?.taskId===task.id;
  const desktopDock=useDesktopAgentDock(),docked=desktopDock&&visible&&!!files.agentHost;
  const [aiMode,setAiMode]=useState<"file"|"task">("file");
  const fileAi=fileFocused&&files.active?.kind==="shared"&&aiMode==="file";
  useEffect(()=>{if(files.aiRequest&&files.aiRequest.fileId===files.active?.id){setAiMode("file");setAiOpen(true);}},[files.aiRequest,files.active?.id]);
  const panel=fileFocused?"code":chosenPanel;
  useEffect(()=>{if(fileFocused&&window.matchMedia("(max-width:1000px)").matches)setAiOpen(false);},[fileFocused,files.active?.id]);
  useEffect(()=>{if(codeRequest)setPanel("code");},[codeRequest]);
  const root=useRef<HTMLElement>(null);
  const aiSize=usePanelSize(`pi-collab:ai-panel:${userId}`,390,320,640);
  const showPanel=(next:Panel)=>{void files.leave().then(ok=>{if(ok){setPanel(next);if(window.matchMedia("(max-width: 1000px)").matches)setAiOpen(false);}});};
  const showComposer=()=>{setAiMode("task");setTaskAiTab("settings");setAiOpen(true);requestAnimationFrame(()=>{root.current?.querySelector<HTMLSelectElement>('[aria-label="恢复来源"]')?.focus();});};
  useEffect(()=>{if(initialThread){setPanel("discussion");if(window.matchMedia("(max-width: 1000px)").matches)setAiOpen(false);}},[initialThread]);
  const [draftReady, setDraftReady] = useState(false), [draftError, setDraftError] = useState(""), [authorized, setAuthorized] = useState(false);
  const draftKeys = runDraftKeys(userId, projectId, task.id);
  const [repositories, setRepositories] = useState<Repository[]>([]), [models, setModels] = useState<Model[]>([]);
  const [revert, setRevert] = useState<Revert | null>(null);
  const [resolution, setResolution] = useState<ResolutionInfo | null>(null);
  const [runs, setRuns] = useState<Run[]>([]), [selected, setSelected] = useState("");
  const [linkedThread,setLinkedThread]=useState<{origin:typeof initialThread;id:string}|null>(null);
  const discussionThread=linkedThread?.origin===initialThread?linkedThread?.id:initialThread;
  const [repositoryId, setRepositoryId] = useState(""), [modelId, setModelId] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]), [snapshotId, setSnapshotId] = useState("");
  const [executionKind,setExecutionKind]=useState<"ai"|"terminal">("ai");
  const [suggestionId, setSuggestionId] = useState("");
  const [editorVersionId, setEditorVersionId] = useState("");
  const [prompt, setPrompt] = useState([task.title, task.description, task.acceptance && `验收标准：\n${task.acceptance}`].filter(Boolean).join("\n\n"));
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [batches, setBatches] = useState<Batch[]>([]), [truncated, setTruncated] = useState(false), [connection, setConnection] = useState("连接中");
  const [pending, setPending] = useState<Start | null>(null), [streamGeneration, setStreamGeneration] = useState(0);
  const [coordinationGeneration, setCoordinationGeneration] = useState(0);
  const [actionReason, setActionReason] = useState(""), [pendingAction, setPendingAction] = useState<{ runId: string; body: RunAction } | null>(null);
  const alive = useRef(true), stopKeys = useRef(new Map<string, string>()), projectRefresh = useRef(onChange);
  useEffect(() => { projectRefresh.current = onChange; }, [onChange]);
  const refreshGeneration = useRef(0);
  const current = runs.find(run => run.id === selected), active = runs.find(run => !terminal.has(run.status));
  const canStart = (role === "maintainer" || (role === "developer" && task.owner_id === userId)) && (!resolution || resolution.input_state === "current") && (!revert || revert.current);
  const canStop = current && (role === "maintainer" || (role === "developer" && current.control?.controllerId === userId && current.control.valid));
  const currentPending = pendingAction?.runId === current?.id ? pendingAction : null;
  const restoration = snapshots.find(snapshot => snapshot.id === snapshotId && snapshot.status === "ready");
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const [next, saved, repair, repo, model] = await Promise.all([collabApi<{ runs: Run[] }>(`tasks/${task.id}/runs`), collabApi<{ snapshots: Snapshot[] }>(`tasks/${task.id}/snapshots`), collabApi<{ resolution: ResolutionInfo | null; revert: Revert | null }>(`tasks/${task.id}/resolution`), collabApi<{ repositories: Repository[] }>(`projects/${projectId}/repositories`), collabApi<{ models: Model[] }>(`projects/${projectId}/models`)]);
      if (alive.current && generation === refreshGeneration.current) { setAuthorized(true); setRepositories(repo.repositories); setModels(model.models); setRepositoryId(id => repo.repositories.some(r => r.id === id) ? id : repo.repositories.find(r=>r.id===next.runs[0]?.repository_id)?.id ?? repo.repositories[0]?.id ?? ""); setModelId(id => model.models.some(m => m.id === id && m.enabled) ? id : model.models.find(m => m.enabled)?.id ?? ""); setRuns(next.runs); setSnapshots(saved.snapshots); setResolution(repair.resolution); setRevert(repair.revert); setSelected(id => next.runs.some(run => run.id === id) ? id : next.runs[0]?.id ?? ""); }
    } catch (error) {
      if (!alive.current || generation !== refreshGeneration.current) return;
      if (error instanceof CollabApiError && [401, 403, 404].includes(error.status)) { setAuthorized(false); setRuns([]); setSnapshots([]); setSelected(""); setBatches([]); }
      throw error;
    }
  }, [task.id, projectId]);
  useEffect(() => {
    let cancelled = false; alive.current = true;
    void refresh()
      .catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    // Each configuration request owns its lifetime. Strict Mode remounts must
    // not let an older response replace a repository the user just selected.
    return () => { cancelled = true; alive.current = false; };
  }, [projectId, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh().catch(e => setError(e.message)); }, 5000);
    const resume = () => { if (document.visibilityState === "visible") { void refresh().catch(e => setError(e.message)); setStreamGeneration(value => value + 1); } };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [refresh]);
  useEffect(() => {
    let cancelled = false, source: EventSource | undefined;
    setBatches([]); setTruncated(false); setConnection("连接中");
    if (!selected) return;
    void collabApi<{ cursor: string; batches: Batch[]; truncated: boolean }>(`runs/${selected}/events`).then(transcript => {
      if (cancelled) return;
      setBatches(transcript.batches); setTruncated(transcript.truncated);
      let cursor = BigInt(transcript.cursor);
      source = new EventSource(`/api/collab/projects/${projectId}/events?after=${transcript.cursor}`);
      source.onopen = () => { if (!cancelled) setConnection("实时连接"); };
      source.onerror = () => { if (!cancelled) setConnection("连接中断，自动重连中"); };
      source.addEventListener("run_event", event => {
        if (cancelled) return;
        const data = JSON.parse(event.data) as Batch & { kind: string; run_id: string | null };
        if (BigInt(data.sequence) <= cursor) return; cursor = BigInt(data.sequence);
        if (data.kind === "run.output" && data.run_id === selected) setBatches(previous => [...previous, data].slice(-100));
        else if (data.kind !== "run.output") { setCoordinationGeneration(value => value + 1); void Promise.all([refresh(), projectRefresh.current()]).catch(e => setError(e.message)); }
      });
      source.addEventListener("snapshot", () => { source?.close(); if (!cancelled) setStreamGeneration(value => value + 1); });
      source.addEventListener("stream_closed", () => { source?.close(); if (!cancelled) { setBatches([]); setConnection("连接已关闭，请刷新运行记录"); setError("实时连接已关闭，请检查会话及项目权限。"); } });
      source.addEventListener("access_revoked", () => { source?.close(); if (!cancelled) { setBatches([]); setRuns([]); setSnapshots([]); setConnection("权限已变更"); setError("会话或项目权限已变更，请刷新页面重新确认访问权限。"); void projectRefresh.current().catch(() => {}); } });
    }).catch(e => { if (!cancelled) { setError(e.message); setConnection("无法读取输出"); } });
    return () => { cancelled = true; source?.close(); };
  }, [selected, projectId, streamGeneration, refresh]);

  useEffect(() => {
    if (!authorized || draftReady) return;
    try {
      const saved = readRunDraft(sessionStorage, { composer: draftKeys.composer, pending: draftKeys.pending });
      if (saved.composer) {
        const d = saved.composer;
        setPrompt(d.prompt); setExecutionKind(d.executionKind); setRepositoryId(d.repositoryId);
        setModelId(d.modelId); setSnapshotId(d.snapshotId); setSuggestionId(d.suggestionId); setEditorVersionId(d.editorVersionId);
      }
      if (saved.pending) {
        const p = saved.pending;
        setPending(p); setPrompt(p.prompt); setExecutionKind(p.executionKind); setRepositoryId(p.repositoryId ?? "");
        setModelId(p.modelProfileId ?? ""); setSnapshotId(p.snapshotId ?? ""); setSuggestionId(p.suggestionId ?? ""); setEditorVersionId(p.editorVersionId ?? "");
      }
      setDraftReady(true); setDraftError("");
    } catch { setDraftError("无法恢复本窗口的运行草稿或请求编号，请先核对运行记录；尚未发送新请求。"); }
  }, [authorized, draftReady, draftKeys.composer, draftKeys.pending]);
  useEffect(() => {
    if (!authorized || !draftReady) return;
    try {
      sessionStorage.setItem(draftKeys.composer, JSON.stringify(runComposerDraft.parse({ version: 1, prompt, executionKind, repositoryId, modelId, snapshotId, suggestionId, editorVersionId })));
      setDraftError("");
    } catch { setDraftError("无法保存本窗口运行草稿，请检查会话存储和可用空间后再启动。"); }
  }, [authorized, draftReady, draftKeys.composer, prompt, executionKind, repositoryId, modelId, snapshotId, suggestionId, editorVersionId]);
  function persistRequest(value: Start | null) {
    try { saveRunRequest(sessionStorage, draftKeys.pending, value); setDraftError(""); return true; }
    catch { setDraftError("无法保存原运行请求编号，尚未发送新的请求。请允许本窗口会话存储后重试。"); return false; }
  }

  async function start(event: FormEvent) {
    event.preventDefault(); const repo = repositories.find(item => item.id === (resolution?.input.repositoryId ?? revert?.repository_id ?? repositoryId)); if ((!repo && !pending) || busy || !draftReady || !authorized) return;
    const body = pending ?? { repositoryId: restoration?.repository_id ?? resolution?.input.repositoryId ?? revert?.repository_id ?? repositoryId, baseSha: restoration?.base_sha ?? resolution?.input.targetSha ?? revert?.target_sha ?? repo!.base_sha, prompt, expectedVersion: task.version, idempotencyKey: crypto.randomUUID(), ...(executionKind==="ai"?{modelProfileId:modelId}:{}), executionKind, ...(snapshotId ? { snapshotId } : {}), ...(suggestionId ? { suggestionId } : {}), ...(editorVersionId ? { editorVersionId } : {}) };
    if (!persistRequest(body)) return;
    setPending(body); setBusy(true); setError("");
    try {
      const result = await collabApi<{ runId: string }>(`tasks/${task.id}/runs`, body);
      if (!alive.current) return;
      // A handed-off editor/suggestion is single-use. Do not leave a consumed
      // version selected in the next-run form after the request succeeds.
      if (persistRequest(null)) setPending(null); setEditorVersionId(""); setSuggestionId(""); setSnapshotId("");
      await refresh(); setSelected(result.runId); await onChange();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof CollabApiError && e.status < 500) { if (persistRequest(null)) setPending(null); if (e.code === "stale_revision") await onChange().catch(() => {}); }
      setError(e instanceof Error ? e.message : "提交失败");
    } finally { setBusy(false); }
  }
  async function stop() {
    if (!current || busy) return; setBusy(true); setError("");
    const key = `${current.id}:${current.control.version}`;
    const idempotencyKey = stopKeys.current.get(key) ?? crypto.randomUUID(); stopKeys.current.set(key, idempotencyKey);
    try { await collabApi(`runs/${current.id}/stop`, { idempotencyKey, controlVersion: current.control.version }); await refresh(); await onChange(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "停止请求失败"); }
    finally { setBusy(false); }
  }
  async function manage(event: FormEvent) {
    event.preventDefault(); if (!current || busy) return;
    const body: RunAction = currentPending?.body ?? { action: current.status === "reconciling" ? "recover" : "archive", reason: actionReason, idempotencyKey: crypto.randomUUID(), expectedRevision: current.revision };
    setPendingAction({ runId: current.id, body }); setBusy(true); setError("");
    try {
      await collabApi(`runs/${current.id}/actions`, body); setPendingAction(null); setActionReason(""); await refresh(); await onChange();
    } catch (e) {
      if (alive.current) {
        if (e instanceof CollabApiError && e.status < 500) { setPendingAction(null); await refresh().catch(() => {}); }
        setError(e instanceof Error ? e.message : "处理请求失败");
      }
    } finally { setBusy(false); }
  }
  const output = chatRows(batches);
  return <section ref={root} className={`collab-run-panel wb-run-shell ${docked?"agent-docked":""} ${fileFocused?"file-focused":""} ${aiOpen?"ai-open":"ai-closed"}`} aria-label="AI 任务运行" style={{"--ai-width":`${aiSize.value}px`} as CSSProperties}>
    <header className="wb-task-heading"><div><h1>{task.title}</h1><span>负责人 {members.find(m=>m.user_id===task.owner_id)?.name??"成员"}{current?` · 发起人 ${members.find(m=>m.user_id===current.requested_by)?.name??"成员"} · 当前控制者 ${current.control?.controllerName??"待确认"}`:" · 尚未选择运行"}</span></div><button className="collab-button" aria-pressed={aiOpen} onClick={()=>setAiOpen(old=>!old)}><WorkbenchIcon name="panel"/>{aiOpen?"收起 AI 面板":"打开 AI 面板"}</button></header>
    <nav className="wb-workspace-nav" aria-label="任务工作区">{panels.map(item=><button key={item.id} aria-pressed={panel===item.id} onClick={()=>showPanel(item.id)}><WorkbenchIcon name={item.icon}/>{item.label}</button>)}</nav>
    <div className="wb-task-split"><div className="wb-editor-surface">
      <Activity mode={panel==="overview"?"visible":"hidden"}><div className="wb-editor-pane">
        {overview}
    <Subtasks key={`subtasks:${task.id}:${userId}`} taskId={task.id} projectId={projectId} runId={current?.execution_kind === "ai" ? current.id : undefined} canPropose={!!current && canStart && (current.requested_by === userId || role === "maintainer")} onOpenTask={onOpenTask} onChange={onChange} />
    {revert && <section className="collab-snapshots" aria-label="固定撤回来源"><h2>固定撤回来源</h2><p>撤回推进 {revert.promotion_id.slice(0,12)} 的完整差异：{revert.old_sha.slice(0,12)} → {revert.new_sha.slice(0,12)}。新任务固定在 {revert.target_sha.slice(0,12)}，保留后续独立修改。</p><p role="status">{revert.current ? "撤回基线有效；启动时在独立工作区生成新提交，有冲突须先解决。" : "基线已变化。请从整合队列重新创建撤回任务；本任务保留历史。"}</p></section>}
    <ResolutionContext resolution={resolution} tasks={tasks} />
      </div></Activity>
      <div hidden={panel!=="code"} className="wb-central-code">
    <TaskCodeWorkspace projectId={projectId} run={current} refresh={refresh} userId={userId} key={`editor:${task.id}:${userId}`} taskId={task.id} taskVersion={task.version} snapshots={snapshots} canManage={canStart} onHandoff={(version,source,kind="ai")=>{setExecutionKind(kind);setEditorVersionId(version);setSuggestionId("");setSnapshotId(source);const saved=snapshots.find(s=>s.id===source);if(saved)setRepositoryId(saved.repository_id);showComposer();if(kind==="terminal"){setPrompt("在此共享草稿版本运行命令、测试或调试。");setTaskAiTab("chat");}}}/>
      </div>
      <Activity mode={panel==="git"?"visible":"hidden"}><div className="wb-editor-pane">
        {!current&&<p className="collab-muted">先启动并结束一次运行，再检查独立工作区的 Git 变更。</p>}
    {current && <WorkspaceGit key={`git:${current.id}:${userId}`} runId={current.id} userId={userId} />}
    {current && <TaskPushPreviews key={`push:${current.id}:${userId}`} runId={current.id} userId={userId} />}
    <GitHubRepositoryInfo binding={repositories.find(r=>r.id===(resolution?.input.repositoryId??repositoryId))?.github} localSha={repositories.find(r=>r.id===(resolution?.input.repositoryId??repositoryId))?.base_sha??""}/>
    <GitHubImports key={projectId} projectId={projectId}/>
    <GitHubSyncs key={`sync-${projectId}`} projectId={projectId} canManage={role === "maintainer"} repository={repositories.find(r => r.id === (resolution?.input.repositoryId ?? revert?.repository_id ?? repositoryId))}/>
    <GitLabPanel key={`gitlab-${projectId}`} projectId={projectId} taskId={task.id} userId={userId}/>
      </div></Activity>
      <Activity mode={panel==="delivery"?"visible":"hidden"}><div className="wb-editor-pane">
        <div className="wb-delivery-steps" aria-label="交付流程"><span>01 保存快照</span><span>02 固定验证</span><span>03 发布成果</span><span>04 组合与独立评审</span><span>05 推进基线</span></div>
    <TaskSnapshots onRestore={canStart && !busy && !pending ? snapshot => {setEditorVersionId("");setSnapshotId(snapshot.id);setSuggestionId("");setRepositoryId(snapshot.repository_id);setPrompt([task.title,task.description,task.acceptance,snapshot.note].filter(Boolean).join("\n\n"));showComposer();} : undefined} snapshots={snapshots} run={current} canCapture={canStart} refresh={refresh} />
    <TaskValidations requiredProfileId={resolution?.input.profileId} key={task.id} projectId={projectId} taskId={task.id} userId={userId} role={role} canRun={canStart} snapshots={snapshots} repositories={repositories} />
    <TaskResults key={`results-${task.id}`} taskId={task.id} runId={current?.id} canPublish={canStart} onChange={onChange} />
    <ProjectIntegrations userId={userId} members={members} onOpenTask={onOpenTask} projectId={projectId} role={role} repositories={repositories} eventGeneration={coordinationGeneration} />
      </div></Activity>
      <Activity mode={panel==="discussion"?"visible":"hidden"}><div className="wb-editor-pane">
    <TaskDiscussions key={`discussions:${task.id}:${discussionThread ?? ""}`} initialThread={discussionThread} contextRun={current?.execution_kind==="ai"&&current.control?.controllerId===userId&&current.control.valid&&current.control.instructionsOpen&&["running","waiting_input"].includes(current.status)?{id:current.id,onSent:()=>{void refresh().catch(e=>setError(e instanceof Error?e.message:"读取运行指令失败"));}}:undefined} taskId={task.id} userId={userId} members={members} snapshots={snapshots} canApply={canStart && !busy && !pending} onApply={(id,source) => {
      setEditorVersionId(""); setSuggestionId(id); setSnapshotId(source); const saved = snapshots.find(s => s.id === source); if (saved) setRepositoryId(saved.repository_id);
      showComposer();
    }}/>
      </div></Activity>
      <Activity mode={panel==="coordination"?"visible":"hidden"}><div className="wb-editor-pane">
    {current && <WorkIntents key={current.id} runId={current.id} eventGeneration={coordinationGeneration} canDeclare={canStart && (role === "maintainer" || current.requested_by === userId) && ["queued", "starting", "running", "waiting_input"].includes(current.status)} snapshots={snapshots} />}
    <TaskNotes key={`notes:${task.id}`} taskId={task.id} tasks={tasks} canSend={canStart} eventGeneration={coordinationGeneration} />
    <TaskContracts key={`contracts-${task.id}`} taskId={task.id} tasks={tasks} runId={current?.id} userId={userId} role={role} canPropose={canStart} repositories={repositories} eventGeneration={coordinationGeneration} onChange={onChange} />
    <ProjectMemory projectId={projectId} taskId={task.id} userId={userId} />
      </div></Activity>
      <Activity mode={panel==="preview"?"visible":"hidden"}><div className="wb-editor-pane">
    <CheckpointPreviews taskId={task.id} userId={userId} />
    <ProjectResources projectId={projectId} role={role} eventGeneration={coordinationGeneration} />
      </div></Activity>
    </div><AgentDock enabled={docked}><aside style={{"--ai-width":`${aiSize.value}px`} as CSSProperties} className="wb-ai" aria-label="当前任务 AI 面板" hidden={!aiOpen}><PanelResize label="调整 AI 面板宽度" value={aiSize.value} onChange={aiSize.change} min={320} max={640} direction="left"/>
      <header className="wb-ai-heading"><strong>Agent</strong><span>{fileAi?"文件对话":current?.execution_kind==="terminal"?"共享终端":"独立 AI 工作区"}</span><button className="wb-icon-button" aria-label="刷新运行记录" title="刷新运行记录" onClick={()=>{void refresh().catch(e=>setError(e.message));setStreamGeneration(value=>value+1);}}>↻</button>{docked&&<button className="wb-icon-button" aria-label="收起 Agent 侧栏" title="收起 Agent 侧栏" onClick={()=>setAiOpen(false)}><WorkbenchIcon name="close"/></button>}</header>
      <nav className="wb-ai-tabs" aria-label="AI 上下文"><button aria-pressed={fileAi} disabled={!fileFocused||files.active?.kind!=="shared"} onClick={()=>setAiMode("file")}>当前文件 AI</button><button aria-pressed={!fileAi} onClick={()=>setAiMode("task")}>项目任务</button></nav>
      <div className="wb-ai-scroll wb-file-chat-host" hidden={!fileAi} ref={files.setAiHost}/>
      {!fileAi&&<AiPanelTabs id={taskAiTabId} value={taskAiTab} onChange={setTaskAiTab}/>}
      <div className={`wb-ai-scroll wb-task-chat-host ${taskAiTab==="chat"?"chat":"settings"}`} hidden={fileAi} role="tabpanel" id={`${taskAiTabId}-${taskAiTab}`} aria-labelledby={`${taskAiTabId}-${taskAiTab}-tab`}>{error&&<div className="collab-error" role="alert">{error}</div>}{draftError&&<p className="collab-error" role="alert">{draftError}</p>}
      <div className="wb-task-chat-transcript" hidden={taskAiTab!=="chat"}><div className="collab-run-view">
      <label className="collab-run-selector">运行记录<select aria-label="运行记录" value={selected} onChange={e => setSelected(e.target.value)}><option value="" disabled>暂无运行</option>{runs.map(run => <option key={run.id} value={run.id}>{new Date(run.created_at).toLocaleString()} · {run.summary?.reason==="folder_import"?"文件夹导入 · ":""}{run.execution_kind==="terminal"?"人工终端 · ":""}{run.execution_kind === "terminal" && run.status === "running" ? "终端运行中" : names[run.status]}</option>)}</select></label>
      {current ? <>
        <div className="collab-run-state"><strong role="status">{current.execution_kind==="terminal"&&current.status==="running"?"人工终端运行中":names[current.status]}</strong><small>{connection}</small>{canStop && !terminal.has(current.status) && current.status !== "reconciling" && <button className="collab-button" disabled={busy || current.status === "stopping"} onClick={() => void stop()}>停止运行</button>}</div>
        <p className="collab-muted collab-small">{(current.execution_kind === "terminal" && current.status === "completed" ? "终端已结束，变更仍需检查和评审。" : current.summary?.reason==="folder_import"?"文件夹准备完成，原目录保持不变。":explain[current.status]) ?? "输出自动保存，可离开页面后继续查看。"}</p>
        {current.summary?.reason && limitReasons[current.summary.reason] && <p role="status">{limitReasons[current.summary.reason]}</p>}
        {current.status === "cancelled" && current.stop_reason === "user_requested" ? <>
          <p role="status">已按成员请求停止运行，工作区和已保存输出保留。停止后模型访问授权随之撤销。</p>
          {current.summary?.error && <details><summary>停止时的诊断记录</summary><p className="collab-prewrap">{current.summary.error}</p></details>}
        </> : current.summary?.error && <p className="collab-run-failure">{failureExplanation(current.summary.error)}</p>}
        {current.stop_reason === "reconciled_without_replay" && <p className="collab-muted collab-small">已解除运行阻塞。可先保存快照，再选择恢复到新工作区；直接启动使用仓库基线。旧文件继续保留。</p>}
        {current.workspace_status === "archived" && <p className="collab-muted" role="status">工作区已归档 · 文件与运行历史保留</p>}
        {current.latest_action?.kind === "recover" && <p className="collab-muted collab-small" role="status">{current.latest_action.status === "pending" ? "等待执行器核对进程退出证据…" : recoveryMessages[current.latest_action.code ?? ""] ?? "对账结果已更新，请检查运行状态。"}</p>}
        {role === "maintainer" && (current.status === "reconciling" || (terminal.has(current.status) && current.workspace_status !== "archived")) && <details><summary>运行维护操作</summary><form className="collab-form compact" onSubmit={manage}>
          <label>处理原因<textarea aria-label="运行处理原因" value={currentPending?.body.reason ?? actionReason} onChange={e => setActionReason(e.target.value)} disabled={busy || !!currentPending} required minLength={10} maxLength={2000} rows={2} placeholder="说明核对退出或保留归档的原因（至少 10 个字符）" /></label>
          <button className="collab-button" disabled={busy || (!currentPending && current.latest_action?.status === "pending")}>{currentPending ? "重试同一处理请求" : current.status === "reconciling" ? "检查旧进程并解除阻塞" : "归档工作区"}</button>
        </form></details>}
        <ChatMessage role="user" text={current.prompt}/>
        {truncated && <p className="collab-muted collab-small">显示最近 100 批输出。</p>}
        {current.summary?.reason==="folder_import"&&<p className="collab-muted">工作文件夹已导入。此记录只准备了代码基线，没有调用 AI；打开共享文件后可在右侧发起对话。</p>}
        {current.execution_kind === "ai" && current.summary?.reason!=="folder_import" && <div className="collab-run-output" role="log" aria-label="AI 运行输出" aria-live="off">{output.length ? <ChatMessages rows={output} active={!terminal.has(current.status)}/> : <p className="collab-muted">{terminal.has(current.status) ? "本次运行没有保存 AI 输出。请查看上方结束状态；若需接续已生成的文件，可保存交接快照后恢复到新工作区。" : "暂无输出。排队和准备期间，状态会自动更新。"}</p>}</div>}
      </> : <p className="collab-muted collab-run-empty">启动后，这里会显示状态、AI 输出与工具执行结果。</p>}
      </div>
    {current && <details className="wb-control-panel"><summary>控制权、问答与成员指令</summary><RunControl key={`control:${current.id}`} runId={current.id} userId={userId} role={role} eventGeneration={coordinationGeneration} onChange={refresh} onOpenDiscussion={id=>{setLinkedThread({origin:initialThread,id});showPanel("discussion");}} /></details>}
      </div>{taskAiTab==="chat"&&current?.execution_kind==="ai"&&!terminal.has(current.status)&&<RunChatComposer key={current.id} runId={current.id} userId={userId} control={current.control} status={current.status} onChange={refresh} onStop={()=>void stop()}/>}<section hidden={taskAiTab==="chat"&&!!active} className="wb-composer"><h3>{taskAiTab==="settings"?"运行设置":executionKind==="terminal"?"终端工作说明":"给 AI 的任务指令"}</h3>
      {loading ? <p>正在读取运行配置…</p> : canStart ? <form className="collab-form compact" onSubmit={start}>
        <div hidden={taskAiTab!=="settings"} className="wb-ai-settings"><button type="button" className="collab-button" disabled={!files.canOpenFolder} onClick={files.openFolder}>打开工作文件夹…</button><label>运行方式<select aria-label="运行方式" value={executionKind} disabled={busy||!!pending} onChange={e=>setExecutionKind(e.target.value as "ai"|"terminal")}><option value="ai">AI 执行</option><option value="terminal">共享人工终端</option></select></label>
        {editorVersionId && <p role="status">已选择共编冻结版本 {editorVersionId.slice(0,8)}。启动后将应用到新工作区。</p>}
        {suggestionId && <p role="status" className="collab-small">将从固定快照创建新工作区并应用建议 {suggestionId.slice(0,8)}，随后启动 AI。<button type="button" className="collab-text-button" onClick={() => setSuggestionId("")} disabled={busy || !!pending}>取消采纳建议</button></p>}
        <label>恢复来源<select aria-label="恢复来源" value={snapshotId} disabled={busy || !!pending} onChange={e => {
          setEditorVersionId(""); setSuggestionId(""); setSnapshotId(e.target.value); const snapshot = snapshots.find(s => s.id === e.target.value);
          if (snapshot) { setRepositoryId(snapshot.repository_id); setPrompt([task.title, task.description, task.acceptance && `验收标准：\n${task.acceptance}`, `交接说明（请重新验证）：\n${snapshot.note}`].filter(Boolean).join("\n\n")); }
        }}><option value="">{resolution ? "固定冲突组合 · 全新修复" : revert ? "固定撤回来源 · 新提交" : "仓库基线 · 全新开始"}</option>{snapshots.filter(s => s.status === "ready").map(s => <option key={s.id} value={s.id}>{new Date(s.created_at).toLocaleString()} · {s.summary?.sourceHead.slice(0, 8)} · 交接快照</option>)}</select></label>
        {restoration && <p className="collab-muted collab-small">将恢复到新工作区。请先检查下方快照的排除清单与环境限制，并重新运行验证。</p>}
        <label>代码仓库<select aria-label="运行仓库" value={resolution?.input.repositoryId ?? revert?.repository_id ?? repositoryId} disabled={busy || !!pending || !!snapshotId || !!resolution || !!revert} onChange={e => setRepositoryId(e.target.value)} required><option value="" disabled>选择仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name} · {repo.base_sha.slice(0, 8)}</option>)}</select></label>
        {executionKind==="ai"&&<label>项目模型<select aria-label="运行模型" value={modelId} disabled={busy || !!pending} onChange={e => setModelId(e.target.value)} required><option value="" disabled>选择模型</option>{models.filter(m => m.enabled).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
        {executionKind==="ai"&&models.find(m => m.id === modelId) && <p className="collab-muted collab-small">每次运行最多 {models.find(m => m.id === modelId)!.run_request_limit} 次模型请求，{models.find(m => m.id === modelId)!.run_token_limit.toLocaleString()} token 额度。</p>}
        <button type="button" className="collab-button" onClick={()=>setTaskAiTab("chat")}>返回对话</button></div>
        <div hidden={taskAiTab!=="chat"}><button type="button" className="collab-text-button wb-ai-model-summary" onClick={()=>setTaskAiTab("settings")}>{executionKind==="terminal"?"共享人工终端":`模型：${models.find(m=>m.id===modelId)?.name??"未配置"}`} · 运行设置</button><label>{executionKind === "terminal" ? "终端工作说明" : "给 AI 的任务指令"}<textarea aria-label={executionKind === "terminal" ? "终端工作说明" : "AI 任务指令"} rows={6} required maxLength={20000} value={prompt} disabled={busy || !!pending} onChange={e => setPrompt(e.target.value)} /></label>
        {!repositories.length && <p className="collab-muted">{role === "maintainer" ? "尚未连接代码仓库。请按项目上方“开始协作”的接入说明配置，再刷新运行记录。" : "尚未连接代码仓库，请联系项目维护者。"}</p>}
        {executionKind === "ai" && !models.some(model => model.enabled) && <p className="collab-muted">{role === "maintainer" ? "尚未配置可用的项目模型。请按项目上方“开始协作”的接入说明配置，再刷新运行记录。" : "尚未配置可用的项目模型，请联系项目维护者。"}</p>}
        {runtime === "docker" && <p className="collab-muted">AI 和共享终端在独立容器中运行；固定快照检查使用单独验证容器。Git 操作在运行停止后执行，成果整合和冲突修复沿用容器验证。</p>}
        {pending && <p className="collab-muted">上次提交尚未确认。重试会沿用同一请求编号和指令。</p>}
        <button className="collab-button primary" disabled={busy || !authorized || !draftReady || (!pending && (!repositoryId || (executionKind==="ai"&&!modelId) || (!!snapshotId && !restoration) || !!active || ["done", "cancelled"].includes(task.status)))}>{busy ? "正在提交…" : pending ? "重试同一请求" : active ? "当前任务已有运行" : executionKind==="terminal"?"打开共享终端":"启动 AI"}</button>
      </div></form> : <p className="collab-muted">可以查看运行记录。任务负责人和项目维护者可以发起运行。</p>}
      </section></div>
    </aside></AgentDock></div>
    {current?.execution_kind==="terminal"&&<details className="wb-bottom-panel" key={current.id} open={!terminal.has(current.status)}><summary><WorkbenchIcon name="terminal"/>终端 · {current.control?.controllerName??"成员"} · {current.status === "running" ? "终端运行中" : names[current.status]}<span>收起面板不会停止运行</span></summary><div className="wb-terminal-content"><SharedTerminal key={`terminal:${current.id}`} runId={current.id} userId={userId} status={current.status} control={current.control} batches={batches} truncated={truncated}/></div></details>}
  </section>;
}
