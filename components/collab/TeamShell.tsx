"use client";
import { Activity, useCallback, useRef, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OpenFolder } from "./OpenFolder";
import { LocalBindingPanel } from "./LocalBindingPanel";
import { workspaceFile } from "./WorkspaceFiles";
import { OperationsStatus } from "./OperationsStatus";
import { HistoryImport } from "./HistoryImport";
import { Inbox } from "./Inbox";
import { editorSaveLabel, editorSaveDescription } from "@/lib/collab/editor-save-state";
import { WorkspaceFilesContext, useWorkspaceFiles, type WorkspaceFile } from "./WorkspaceFiles";
import { CodeBrowser } from "./CodeBrowser";
import { TaskRuns } from "./TaskRuns";
import { CollabApiError } from "./api";
import { Capacity } from "./Capacity";
import { ProjectMap } from "./ProjectMap";
import { TaskEditor } from "./TaskEditor";
import { GettingStarted } from "./GettingStarted";
import { CommandPalette, PanelResize, ThemeControl, WorkbenchIcon, usePanelSize, type WorkbenchCommand } from "./WorkbenchChrome";

type User = { id: string; name: string; email: string };
type Project = { id: string; organization_id: string; name: string; description: string; role: string };
type Task = { id: string; title: string; description: string; acceptance: string; status: string; owner_id: string; owner_name: string; owner_active: boolean; version: number; is_resolution: boolean };
type Detail = { project: Project; tasks: Task[]; members: { user_id: string; name: string; role: string }[]; dependencies: { task_id: string; depends_on: string; kind: string }[]; activity: { id: string; action: string; resource_id: string; actor_name: string; created_at: string }[] };
type Projects = { deletedOrganizations?: { id: string; name: string }[]; projects: Project[]; organizations: { id: string; name: string; role: string }[] };
const roleNames: Record<string, string> = { maintainer: "维护者", developer: "开发者", reviewer: "评审者", viewer: "观察者" };
const statusNames: Record<string, string> = { draft: "草稿", ready: "待开始", in_progress: "进行中", in_review: "评审中", ready_to_merge: "待合并", done: "已完成", blocked: "阻塞", cancelled: "已取消" };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/collab/${path}`, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (response.status === 401) throw new CollabApiError("会话已失效，请刷新页面并重新登录。", 401, "unauthenticated");
  if (!response.ok) throw new CollabApiError(result.message ?? "请求未完成，请稍后重试。", response.status, result.error ?? "request_failed");
  return result;
}

export function TeamShell({ user, runtime }: { user: User; runtime: string }) {
  const router = useRouter();
  const [folderOpen,setFolderOpen]=useState(false);
  const [catalogue, setCatalogue] = useState<Projects>({ projects: [], organizations: [] });
  const [selected, setSelected] = useState("");
  const detailRequest = useRef({ project: "", generation: 0, closed: true });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"task" | "project" | null>(null);
  const [openTask, setActiveTask] = useState<string | null>(null);
  const [tabs,setTabs]=useState<string[]>([]),[search,setSearch]=useState(""),[mine,setMine]=useState(false),[sidebar,setSidebar]=useState(true),[commandsOpen,setCommandsOpen]=useState(false);
  const sidebarSize=usePanelSize(`pi-collab:sidebar:${user.id}`,260,220,420);
  const setOpenTask=useCallback((id:string|null)=>{setActiveTask(id);if(id)setTabs(old=>old.includes(id)?old:[...old,id]);},[]);
  const tabStrip=useRef<HTMLDivElement>(null);
  const linkedTaskOpened=useRef(false);
  const inboxTarget = useRef<{ project: string; task: string; thread: string | null } | null>(null);
  const [discussionThread,setDiscussionThread] = useState<string | null>(null);
  const [view, setView] = useState<"tasks" | "map" | "capacity" | "history" | "team" | "code">("tasks");
  const [sidebarMode,setSidebarMode]=useState<"tasks"|"files">("tasks"),[codeRequest,setCodeRequest]=useState(0);
  const activateFile=useCallback((file:WorkspaceFile)=>{setView(file.taskId?"tasks":"code");if(file.taskId)setOpenTask(file.taskId);setForm(null);setSidebarMode("files");if(window.matchMedia("(max-width:760px)").matches)setSidebar(false);},[setOpenTask]);
  const files=useWorkspaceFiles(activateFile),resetFiles=files.reset,restoreFiles=files.restore;
  useEffect(()=>{tabStrip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({block:"nearest",inline:"nearest"});},[files.active?.id,openTask]);
  const showExplorer=()=>{setSidebarMode("files");setSidebar(true);setCodeRequest(v=>v+1);setForm(null);if(view!=="tasks"||!openTask)setView("code");};
  const loadCatalogue = useCallback(async () => {
    const next = await api<Projects>("projects");
    setCatalogue(next);
    setSelected(current => next.projects.some(p => p.id === current) ? current : next.projects.find(p=>p.id===new URLSearchParams(window.location.search).get("project"))?.id ?? next.projects[0]?.id ?? "");
    return next;
  }, []);
  useEffect(() => { void loadCatalogue().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [loadCatalogue]);
  useEffect(() => {
    const scope = { project: selected, generation: 0, closed: false };
    detailRequest.current = scope;
    setDetail(null); setOpenTask(null); setTabs([]); resetFiles(); setSearch(""); setError("");
    if (selected) void api<Detail>(`projects/${selected}`).then(next => { if (!scope.closed && scope.generation === 0) { setDetail(next); if (inboxTarget.current?.project === selected) { setOpenTask(inboxTarget.current.task); setDiscussionThread(inboxTarget.current.thread); }
      else if(!linkedTaskOpened.current&&new URLSearchParams(window.location.search).get("project")===selected&&next.tasks.some(t=>t.id===new URLSearchParams(window.location.search).get("task"))){linkedTaskOpened.current=true;setOpenTask(new URLSearchParams(window.location.search).get("task"));}
      else { try { const saved=JSON.parse(sessionStorage.getItem(`pi-collab:tabs:${user.id}:${selected}`)??"null");if(saved&&Array.isArray(saved.tabs)){const ids=saved.tabs.filter((id:unknown)=>typeof id==="string"&&next.tasks.some(t=>t.id===id)).slice(0,32);setTabs(ids);setActiveTask(ids.includes(saved.active)?saved.active:null);} restoreFiles(sessionStorage.getItem(`pi-collab:files:${user.id}:${selected}`),selected,next.tasks.map(t=>t.id)); }catch{} } } }).catch(e => { if (!scope.closed && scope.generation === 0) setError(e.message); });
    return () => { scope.closed = true; };
  }, [selected,setOpenTask,user.id,resetFiles,restoreFiles]);
  const reload = useCallback(async () => {
    const scope = detailRequest.current;
    if (!selected || scope.closed || scope.project !== selected) return;
    const generation = ++scope.generation;
    try {
      const next = await api<Detail>(`projects/${selected}`);
      if (!scope.closed && scope.generation === generation) setDetail(next);
    }
    catch (error) {
      if (scope.closed || scope.generation !== generation) return;
      if (error instanceof CollabApiError && [401, 403, 404].includes(error.status)) { setDetail(null); setOpenTask(null); await loadCatalogue().catch(() => {}); }
      throw error;
    }
  },[selected,loadCatalogue,setOpenTask]);
  useEffect(()=>{const resume=()=>{if(!document.hidden)void reload().catch(e=>setError(e.message));};const timer=setInterval(resume,10000);window.addEventListener("focus",resume);window.addEventListener("online",resume);return()=>{clearInterval(timer);window.removeEventListener("focus",resume);window.removeEventListener("online",resume);};},[reload]);
  useEffect(()=>{if(form&&window.matchMedia("(max-width:760px)").matches)setSidebar(false);},[form]);
  const canWrite = detail && ["maintainer", "developer"].includes(detail.project.role);
  const openFolder=()=>{void files.leave().then(ok=>{if(ok)setFolderOpen(true);});};
  const canCreateProject = catalogue.organizations.some(o => ["owner", "admin"].includes(o.role));
  useEffect(()=>{if(detail?.project.id!==selected)return;try{sessionStorage.setItem(`pi-collab:tabs:${user.id}:${selected}`,JSON.stringify({tabs,active:openTask}));}catch{}},[detail,selected,tabs,openTask,user.id]);
  useEffect(()=>{if(detail?.project.id!==selected)return;try{sessionStorage.setItem(`pi-collab:files:${user.id}:${selected}`,JSON.stringify({tabs:files.tabs,active:files.active?.id??null}));}catch{}},[detail,selected,files.tabs,files.active,user.id]);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.isComposing||event.repeat)return;const target=event.target as HTMLElement|null;if(target?.closest('input,textarea,select,[contenteditable="true"],.cm-editor,.xterm'))return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setCommandsOpen(true);}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="b"){event.preventDefault();setSidebar(old=>!old);}};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[]);
  const task = detail?.tasks.find(t => t.id === openTask);
  const open = (id:string)=>{void files.leave().then(ok=>{if(!ok)return;setOpenTask(id);setView("tasks");setForm(null);if(window.matchMedia("(max-width:760px)").matches)setSidebar(false);});};
  const switchProject=(id:string)=>{void files.leave().then(ok=>{if(!ok)return;inboxTarget.current=null;setSelected(id);setForm(null);setView("tasks");});};
  const closeTab=(id:string)=>{const finish=()=>{files.forgetTask(id);setTabs(old=>old.filter(t=>t!==id));if(openTask===id)setActiveTask(tabs.filter(t=>t!==id).at(-1)??null);};if(files.active?.taskId===id)void files.leave().then(ok=>{if(ok)finish();});else finish();};
  const navigate=(next:typeof view)=>{void files.leave().then(ok=>{if(ok){setView(next);setForm(null);}});};
  const openForm=(next:"task"|"project")=>{void files.leave().then(ok=>{if(ok)setForm(next);});};
  const commands:WorkbenchCommand[]=[
    ...catalogue.projects.map(p=>({id:`project:${p.id}`,label:p.name,detail:"切换项目",run:()=>switchProject(p.id)})),
    ...(detail?.tasks??[]).map(t=>({id:`task:${t.id}`,label:t.title,detail:`任务 · ${t.owner_name} · ${statusNames[t.status]}`,run:()=>open(t.id)})),
    ...(canWrite?[{id:"folder",label:"打开工作文件夹",detail:"选择本机目录，创建协作副本并打开编辑器",run:openFolder}]:[]),
    {id:"code",label:"项目代码",detail:"浏览仓库文件与代码，无需启动 AI",run:showExplorer},
    {id:"map",label:"任务与 AI 全景",detail:"查看并行工作、依赖与冲突",run:()=>navigate("map")},
    {id:"capacity",label:"资源与费用",detail:"项目配额与执行环境",run:()=>navigate("capacity")},
    {id:"team",label:"团队与活动",detail:"成员、角色与项目动态",run:()=>navigate("team")},
    ...(canWrite?[{id:"create",label:"新建任务",detail:"写下目标与验收标准",run:()=>openForm("task")}]:[]),
  ];
  const memberName = (id: string) => detail?.members.find(m => m.user_id === id)?.name ?? detail?.tasks.find(t => t.owner_id === id)?.owner_name ?? "成员";

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try {
      if (form === "project") {
        const project = await api<Project>("projects", { name: fields.get("name"), description: fields.get("description"), organizationId: fields.get("organizationId") });
        await loadCatalogue(); setSelected(project.id);
      } else {
        const created = await api<Task>(`projects/${selected}/tasks`, { title: fields.get("title"), description: fields.get("description"), acceptance: fields.get("acceptance") });
        await reload(); setOpenTask(created.id);
      }
      setView("tasks"); setForm(null);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function addDependency(event: FormEvent<HTMLFormElement>, taskId:string) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await api(`tasks/${taskId}/dependencies`, { dependsOn: fields.get("dependsOn"), kind: fields.get("kind") }); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "依赖更新失败"); }
    finally { setBusy(false); }
  }

  const visibleTasks=detail?.tasks.filter(item=>(!mine||item.owner_id===user.id)&&`${item.title} ${item.owner_name}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))??[];
  const team = detail && <section className="wb-team" aria-label="团队与活动"><div><h2>项目成员</h2><p className="collab-muted">成员角色决定访问范围；在线状态在具体共编房间中显示。</p>{detail.members.map(member=><div className="collab-member" key={member.user_id}><span className="collab-avatar">{member.name.slice(0,1)}</span><span>{member.name}</span><small>{roleNames[member.role]}</small></div>)}{detail.project.role==="maintainer"&&<Link href={`/projects/${detail.project.id}/members`}>管理项目成员</Link>}</div><div><h2>最近活动</h2>{detail.activity.length?detail.activity.map(event=><div className="collab-activity" key={event.id}><strong>{event.actor_name}</strong><span>{({"task.created":"创建了任务","task.updated":"更新了任务","project.created":"创建了项目","task.dependency_added":"更新了依赖","project.member_changed":"更新了成员权限"} as Record<string,string>)[event.action]??event.action}</span><time>{new Date(event.created_at).toLocaleString()}</time></div>):<p className="collab-muted">项目活动将在这里记录。</p>}</div></section>;
  return <WorkspaceFilesContext.Provider value={{...files,scope:view==="tasks"&&openTask?openTask:selected,showExplorer,openFolder,canOpenFolder:!!canWrite}}><div className={`collab-app wb-app ${sidebar?"":"sidebar-hidden"}`} style={{"--sidebar-width":`${sidebarSize.value}px`} as CSSProperties}>
    <nav className="wb-activity" aria-label="工作台导航"><button className="wb-brand" title="项目任务" aria-label="项目任务" onClick={()=>{setSidebarMode("tasks");setSidebar(true);navigate("tasks");}}>π</button>
      {([{id:"tasks",icon:"tasks",label:"项目与任务"},{id:"code",icon:"code",label:"项目代码"},{id:"map",icon:"map",label:"任务与 AI 全景"},{id:"team",icon:"team",label:"团队与活动"},{id:"capacity",icon:"settings",label:"资源与费用"},{id:"history",icon:"history",label:"个人历史"}] as const).map(item=><button key={item.id} aria-label={item.label} title={item.label} aria-pressed={item.id==="code"?sidebarMode==="files":item.id==="tasks"?sidebarMode==="tasks"&&view==="tasks":view===item.id} onClick={()=>{if(item.id==="code"){showExplorer();return;}if(item.id==="tasks"){setSidebarMode("tasks");setSidebar(true);}void files.leave().then(ok=>{if(ok){setView(item.id);setForm(null);}});}}><WorkbenchIcon name={item.icon}/></button>)}
      <button className="wb-activity-bottom" aria-label="搜索项目和任务" title="搜索项目和任务 · Ctrl / ⌘ K" onClick={()=>setCommandsOpen(true)}><WorkbenchIcon name="search"/></button><Link href="/account" aria-label="账户安全" title="账户安全"><span className="collab-avatar">{user.name.slice(0,1)}</span></Link>
    </nav>
    <aside className="collab-sidebar wb-sidebar" aria-label="工作台侧边栏"><div className="wb-sidebar-heading"><strong>{sidebarMode==="files"?"资源管理器":"项目与任务"}</strong><button className="collab-text-button" onClick={()=>setSidebar(false)} aria-label="收起侧栏"><WorkbenchIcon name="panel"/></button></div>
      <label className="wb-project-select">当前项目<select aria-label="当前项目" value={selected} onChange={e=>switchProject(e.target.value)}>{!catalogue.projects.length&&<option value="">尚无项目</option>}{catalogue.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {canWrite&&<button className="collab-button wb-open-folder" onClick={openFolder}>＋ 打开文件夹…</button>}
      <LocalBindingPanel projectId={selected} canManage={!!canWrite}/>
      <div className="wb-sidebar-switch"><button aria-pressed={sidebarMode==="files"} onClick={showExplorer}>文件</button><button aria-pressed={sidebarMode==="tasks"} onClick={()=>setSidebarMode("tasks")}>任务</button></div>
      <div className="wb-explorer-host" ref={files.setSidebarHost} hidden={sidebarMode!=="files"}/>
      <div className="wb-sidebar-task-content" hidden={sidebarMode!=="tasks"}>
      <div className="wb-sidebar-tools"><input aria-label="搜索任务" placeholder="搜索任务或负责人…" value={search} onChange={e=>setSearch(e.target.value)}/><button title="刷新任务" aria-label="刷新任务" onClick={()=>void reload().catch(e=>setError(e.message))}>↻</button></div>
      <div className="wb-task-filters"><button aria-pressed={!mine} onClick={()=>setMine(false)}>全部任务</button><button aria-pressed={mine} onClick={()=>setMine(true)}>我的任务</button>{canWrite&&<button aria-label="新建任务" title="新建任务" onClick={()=>openForm("task")}>＋</button>}</div>
      <nav className="wb-task-list" aria-label="任务">{visibleTasks.map(item=><button key={item.id} className={`wb-task-link ${openTask===item.id?"selected":""}`} onClick={()=>open(item.id)} title={item.title}><span className={`wb-state-dot state-${item.status}`} aria-hidden="true"/><span><strong>{item.title}</strong><small>{memberName(item.owner_id)} · {statusNames[item.status]}{!item.owner_active?" · 权限已停用":""}</small></span></button>)}{!visibleTasks.length&&<p className="collab-muted">{search?"没有匹配的任务":mine?"暂时没有分配给你的任务":"创建任务，开始协作。"}</p>}</nav>
      </div>
      <div className="wb-sidebar-settings">{canCreateProject&&<button className="collab-text-button" onClick={()=>openForm("project")}>＋ 新建项目</button>}<ThemeControl/><details><summary>团队与账户</summary><Link href="/account">账户安全</Link>{catalogue.organizations.filter(o=>["owner","admin"].includes(o.role)).map(o=><Link key={o.id} href={`/organizations/${o.id}`}>管理 {o.name}</Link>)}{catalogue.deletedOrganizations?.map(o=><Link key={o.id} href={`/organizations/${o.id}`}>恢复 {o.name}</Link>)}<p>{user.name}<br/><small>{user.email}</small></p><button className="collab-text-button" onClick={async()=>{await api("auth/sign-out",{});router.replace("/sign-in");router.refresh();}}>退出登录</button></details></div>
      <PanelResize label="调整项目侧栏宽度" value={sidebarSize.value} onChange={sidebarSize.change} min={220} max={420}/>
    </aside>
    <main className="collab-main wb-main"><header className="collab-topbar wb-titlebar"><button className="wb-icon-button" aria-label={sidebar?"收起侧栏":"展开侧栏"} title="切换侧栏 · Ctrl / ⌘ B" onClick={()=>setSidebar(old=>!old)}><WorkbenchIcon name="panel"/></button><span className="wb-title-project">{detail?.project.name??"pi-collab"}</span><button className="wb-command-trigger" onClick={()=>setCommandsOpen(true)}><WorkbenchIcon name="search"/><span>搜索项目、任务和命令</span><kbd>⌘ K</kbd></button><Inbox onOpen={(project,task,thread)=>{void files.leave().then(ok=>{if(!ok)return;inboxTarget.current={project,task,thread};setView("tasks");setForm(null);setDiscussionThread(thread);if(selected===project)setOpenTask(task);else setSelected(project);});}}/></header>
      {folderOpen&&detail&&<OpenFolder key={selected} projectId={selected} projectName={detail.project.name} onClose={()=>setFolderOpen(false)} onOpened={async result=>{await reload();setOpenTask(result.taskId);setView("tasks");setForm(null);setSidebarMode("files");setSidebar(true);setCodeRequest(v=>v+1);if(result.firstFile){const ok=await files.open(workspaceFile({projectId:selected,taskId:result.taskId,kind:"shared",source:result.sessionId,path:result.firstFile}));if(!ok)throw new Error("目录已导入，请先解决当前文件保存问题后再打开。");}files.setNotice(`已打开工作文件夹 ${result.folderName} · 原目录未修改${result.excluded.length?` · 服务端排除 ${result.excluded.map(f=>f.path).join("、")}（疑似凭据）`:""}`);}}/>}<OperationsStatus/>{error&&<div className="collab-error" role="alert">{error}<button className="collab-text-button" onClick={()=>setError("")}>关闭</button></div>}
      {files.error&&<p role="alert" className="collab-error">{files.error}</p>}{files.notice&&<div className="wb-workspace-notice" role="status">{files.notice}<button aria-label="关闭操作提示" onClick={()=>files.setNotice("")}>×</button></div>}
      <div ref={tabStrip} className="wb-open-tabs" aria-label="工作台标签页"><button className={!files.active&&!openTask&&view==="tasks"?"selected":""} onClick={()=>{void files.leave().then(ok=>{if(ok){setOpenTask(null);setView("tasks");setForm(null);}});}}>项目概览</button>{tabs.filter(id=>detail?.tasks.some(t=>t.id===id)).map(id=><div key={id} className={!files.active&&openTask===id&&view==="tasks"?"selected":""}><button aria-current={!files.active&&openTask===id&&view==="tasks"?"page":undefined} onClick={()=>open(id)}>{detail!.tasks.find(t=>t.id===id)!.title}</button><button title="关闭任务及其文件标签，运行继续保留" aria-label={`关闭任务标签：${detail!.tasks.find(t=>t.id===id)!.title}`} onClick={()=>closeTab(id)}><WorkbenchIcon name="close"/></button></div>)}{files.tabs.map(file=><div key={file.id} draggable onDragStart={e=>{e.dataTransfer.setData("application/x-pi-collab-file-tab",file.id);e.dataTransfer.effectAllowed="move";}} onDragOver={e=>{if(e.dataTransfer.types.includes("application/x-pi-collab-file-tab")){e.preventDefault();e.dataTransfer.dropEffect="move";}}} onDrop={e=>{e.preventDefault();files.reorder(e.dataTransfer.getData("application/x-pi-collab-file-tab"),file.id);}} onKeyDown={e=>{if(e.altKey&&e.shiftKey&&(e.key==="ArrowLeft"||e.key==="ArrowRight")){e.preventDefault();const index=files.tabs.findIndex(f=>f.id===file.id),target=files.tabs[index+(e.key==="ArrowRight"?1:-1)];if(target)files.reorder(file.id,target.id);}}} className={files.active?.id===file.id?"selected":""}><button title={`${file.path} · ${file.kind==="shared"?"共享草稿":"代码浏览"} · ${detail?.tasks.find(t=>t.id===file.taskId)?.title??detail?.project.name} · ${file.source}`} aria-current={files.active?.id===file.id?"page":undefined} onClick={()=>void files.open(file)}><WorkbenchIcon name="code"/>{file.path.split("/").at(-1)}<small>{file.kind==="shared"?"共编":"只读"}</small>{file.kind==="shared"&&<span className={`wb-tab-save state-${files.statuses[file.id]?.phase??"connecting"}`} title={files.statuses[file.id]?editorSaveDescription(files.statuses[file.id]):"打开此标签后核对保存状态"} aria-label={`${file.path}：${files.statuses[file.id]?editorSaveLabel(files.statuses[file.id]):"待核对"}`}>{files.statuses[file.id]?.dirty?"●":files.statuses[file.id]?.phase==="saving"?"↻":files.statuses[file.id]?.phase==="saved"?"✓":["error","offline"].includes(files.statuses[file.id]?.phase)?"!":"○"}</span>}</button><button aria-label={`关闭文件标签：${file.path}`} onClick={()=>void files.close(file.id)}><WorkbenchIcon name="close"/></button></div>)}</div>
      <div className="wb-content">
      {!loading&&!form&&!task&&view==="tasks"&&(!selected||detail)&&<GettingStarted key={selected} project={detail?.project} organizations={catalogue.organizations} onCreateProject={()=>openForm("project")}/>}
      {form&&<section className="collab-editor-panel wb-page"><div className="collab-section-heading"><h1>{form==="project"?"新建项目":"新建任务"}</h1><button className="collab-text-button" onClick={()=>setForm(null)}>取消</button></div>
          <form className="collab-form" onSubmit={create}>
            {form === "project" ? <>
              <label>所属团队<select name="organizationId">{catalogue.organizations.filter(o => ["owner", "admin"].includes(o.role)).map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label>
              <label>项目名称<input name="name" maxLength={120} required autoFocus /></label>
            </> : <label>任务名称<input name="title" maxLength={200} required autoFocus placeholder="例如：为订单接口添加分页" /></label>}
            <label>{form === "project" ? "项目说明" : "目标与修改范围"}<textarea name="description" rows={4} maxLength={5000} /></label>
            {form === "task" && <label>验收标准<textarea name="acceptance" rows={3} maxLength={20000} placeholder="完成后，如何证明这个任务达到了预期？" /></label>}
            <button className="collab-button primary" disabled={busy}>{busy ? "正在创建…" : "创建"}</button>
          </form>
      </section>}
      {detail&&!form&&view==="tasks"&&!task&&<section className="wb-welcome wb-page"><p className="collab-eyebrow">PI-COLLAB / WORKSPACE</p><h1>{detail.project.name}</h1><p className="collab-muted">{detail.project.description||"把目标拆成任务，让每位成员与 AI 在独立工作区中推进。"}</p><div className="wb-overview-metrics"><div><strong>{detail.tasks.length}</strong><span>团队任务</span></div><div><strong>{detail.tasks.filter(t=>t.status==="in_progress").length}</strong><span>进行中的任务</span></div><div><strong>{detail.dependencies.length}</strong><span>任务依赖</span></div></div><div className="wb-quick-actions">{canWrite&&<button className="collab-button primary" onClick={()=>openForm("task")}>＋ 新建任务</button>}<button className="collab-button" onClick={()=>navigate("map")}><WorkbenchIcon name="map"/>查看团队 AI 全景</button></div><h2>最近任务</h2><div className="wb-recent-tasks">{detail.tasks.slice(0,8).map(t=><button key={t.id} onClick={()=>open(t.id)}><span>{t.title}</span><small>{t.owner_name} · {statusNames[t.status]}</small></button>)}</div>{team}</section>}
      {detail&&<><Activity mode={!form&&view==="code"?"visible":"hidden"}><div className="wb-project-code"><CodeBrowser key={detail.project.id} projectId={detail.project.id}/></div></Activity><Activity mode={!form&&view==="map"?"visible":"hidden"}><div className="wb-page"><ProjectMap key={detail.project.id} projectId={detail.project.id} userId={user.id} onOpenTask={id=>void reload().then(()=>open(id)).catch(e=>setError(e.message))}/></div></Activity><Activity mode={!form&&view==="capacity"?"visible":"hidden"}><div className="wb-page"><Capacity key={detail.project.id} projectId={detail.project.id}/></div></Activity><Activity mode={!form&&view==="history"?"visible":"hidden"}><div className="wb-page"><HistoryImport key={detail.project.id} projectId={detail.project.id} userId={user.id} canWrite={!!canWrite}/></div></Activity><Activity mode={!form&&view==="team"?"visible":"hidden"}><div className="wb-page">{team}</div></Activity>
      {tabs.map(id=>{const task=detail.tasks.find(t=>t.id===id);if(!task)return null;return <Activity key={id} mode={!form&&view==="tasks"&&openTask===id?"visible":"hidden"}><TaskRuns visible={!form&&view==="tasks"&&openTask===id} codeRequest={codeRequest} initialThread={inboxTarget.current?.task===id?discussionThread:null} members={detail.members} onOpenTask={async id=>{await reload();open(id);}} task={task} tasks={detail.tasks} projectId={detail.project.id} userId={user.id} role={detail.project.role} runtime={runtime} onChange={reload} overview={<section className="wb-task-overview">
<h2>{task.title}</h2><p className="collab-muted collab-prewrap">{task.description || "尚未填写说明"}</p><h3>验收标准</h3><p className="collab-prewrap">{task.acceptance || "尚未填写验收标准"}</p><h3>前置依赖</h3>
                {detail.dependencies.filter(d => d.task_id === task.id).map(d => <div className="collab-dependency" key={d.depends_on}>{detail.tasks.find(t => t.id === d.depends_on)?.title}<small>{d.kind === "strict" ? "等待上游结果" : "可以先用约定开发"}</small></div>)}
                {task.is_resolution && <p className="collab-muted collab-small">修复任务的依赖已固定为原整合来源，不能添加或更换。来源失效后请重新整合。</p>}
                {canWrite && !task.is_resolution && (detail.project.role === "maintainer" || task.owner_id === user.id) && detail.tasks.length > 1 && <form className="collab-form compact" onSubmit={event=>void addDependency(event,task.id)}><label>添加依赖<select name="dependsOn" aria-label="添加依赖" required>{detail.tasks.filter(t => t.id !== task.id && !detail.dependencies.some(d => d.task_id === task.id && d.depends_on === t.id)).map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select></label><label>依赖方式<select name="kind" aria-label="依赖方式"><option value="strict">严格：等待上游结果</option><option value="soft">软依赖：先按契约开发</option></select></label><button className="collab-button" disabled={busy}>添加依赖</button></form>}
                <TaskEditor key={task.id} task={task} canEdit={!!canWrite && (detail.project.role === "maintainer" || task.owner_id === user.id)} onChange={reload} />

      </section>}/></Activity>;})}</>}
      {!detail&&!form&&<section className="collab-empty"><h1>{loading||selected?"正在加载工作空间…":"欢迎加入 pi-collab"}</h1>{!loading&&!selected&&<p>请创建第一个项目，或联系管理员邀请你加入。</p>}</section>}
      </div><footer className="wb-statusbar"><span><WorkbenchIcon name="git"/>独立工作区</span><span>{runtime==="docker"?"Docker":"原生执行"}</span>{files.active&&<span className="wb-footer-save" title={files.statuses[files.active.id]?editorSaveDescription(files.statuses[files.active.id]):undefined}>{files.active.kind==="browse"?"只读":files.statuses[files.active.id]?editorSaveLabel(files.statuses[files.active.id]):"连接中…"}</span>}<span className="wb-status-spacer"/><span>{detail?roleNames[detail.project.role]:"团队成员"}</span><span>{user.name}</span></footer>
    </main><div className="wb-agent-dock" ref={files.setAgentHost}/>{commandsOpen&&<CommandPalette commands={commands} onClose={()=>setCommandsOpen(false)}/>}
  </div></WorkspaceFilesContext.Provider>;
}
