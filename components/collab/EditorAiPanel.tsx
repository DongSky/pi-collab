"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AiPanelTabs, type AiPanelTab } from "./AiPanelTabs";
import { collabApi, CollabApiError } from "./api";
import { useFiles } from "./WorkspaceFiles";
import { EditorMergeDiff } from "./EditorMergeDiff";
import { type ControlState } from "./RunControl";
import { RunQuestions } from "./RunQuestions";
import { ChatMessage, ChatMessages } from "./ChatMessages";
import {
  chatRows,
  withChatInstructions,
  type ChatEvent,
  type ChatRow,
} from "@/lib/collab/chat-transcript";

export type EditorAiBase = { text: string; revision: string; token: string };
type Job = { taskId: string; projectId: string; runId: string };
type Turn = { role: "user" | "assistant"; text: string };
type Request = {
  conversation?: Turn[];
  requestKey: string;
  modelId: string;
  instruction: string;
  context: EditorAiBase;
};
type Instruction = {
  expectedVersion: string;
  kind: "steer" | "follow_up";
  message: string;
  idempotencyKey: string;
};
type Saved = {
  pendingInstruction?: Instruction;
  history?: { question: string; rows: ChatRow[]; runId?: string }[];
  rows?: ChatRow[];
  followups?: { text: string; id: string; after?: string }[];
  request: Request;
  job?: Job;
  candidate?: string;
  applied?: boolean;
  handedToMerge?: boolean;
};
type Run = { status: string; summary?: { error?: string } };
const ended = new Set(["completed", "failed", "cancelled"]);
const labels: Record<string, string> = {
  queued: "排队中",
  starting: "准备工作区",
  running: "AI 正在编辑",
  waiting_input: "等待你的回答",
  stopping: "正在停止",
  completed: "已完成 · 等待检查",
  failed: "运行失败",
  cancelled: "已停止",
  reconciling: "需要在任务中核对运行",
};
export function EditorAiPanel({
  userId,
  sessionId,
  documentId,
  filename,
  capture,
  apply,
  disabled,
}: {
  userId: string;
  sessionId: string;
  documentId: string;
  filename: string;
  capture: () => Promise<EditorAiBase>;
  apply: (base: EditorAiBase, text: string) => Promise<"saved" | "conflict">;
  disabled: boolean;
}) {
  const [tab, setTab] = useState<AiPanelTab>("chat"),
    tabId = useId();
  const workspace = useFiles(),
    projectId = workspace.active?.projectId;
  const [folder, setFolder] = useState<{
      name: string;
      repositoryId: string;
    } | null>(null),
    [directory, setDirectory] = useState("");
  useEffect(() => {
    let alive = true;
    void collabApi<{ name: string; repositoryId: string }>(
      `editors/${sessionId}/folder`,
    )
      .then((r) => {
        if (alive) setFolder(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);
  const [models, setModels] = useState<
      { id: string; name: string; enabled: boolean }[]
    >([]),
    [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(""),
    [saved, setSaved] = useState<Saved | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [run, setRun] = useState<Run | null>(null),
    [output, setOutput] = useState<ChatRow[]>([]),
    [truncated, setTruncated] = useState(false);
  const [archives, setArchives] = useState<Saved[]>([]),
    [showHistory, setShowHistory] = useState(false);
  const stopKey = useRef(crypto.randomUUID());
  const timeline = useRef<HTMLDivElement>(null),
    stickToBottom = useRef(true);
  const [instruction, setInstruction] = useState<Instruction | null>(null),
    [instructionKind, setInstructionKind] = useState<"steer" | "follow_up">(
      "steer",
    );
  useEffect(() => {
    if (stickToBottom.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [output, saved, notice, tab]);
  const key = `pi-collab:editor-ai:${userId}:${sessionId}:${documentId}`;
  useEffect(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (v?.request?.context && v.request.requestKey) {
        setSaved(v);
        setOutput(v.rows ?? []);
        setInstruction(v.pendingInstruction ?? null);
      }
      setPrompt(sessionStorage.getItem(`${key}:prompt`) ?? "");
      const archive = JSON.parse(
        sessionStorage.getItem(`${key}:history`) ?? "[]",
      );
      if (Array.isArray(archive)) setArchives(archive);
    } catch {}
    setReady(true);
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      if (saved)
        sessionStorage.setItem(
          key,
          JSON.stringify({ ...saved, pendingInstruction: instruction }),
        );
      else sessionStorage.removeItem(key);
      sessionStorage.setItem(`${key}:prompt`, prompt);
    } catch {
      setError("无法保存本窗口 AI 记录，请保留页面或打开完整任务。");
    }
  }, [key, saved, ready, prompt, instruction]);
  useEffect(() => {
    let alive = true;
    if (projectId)
      void collabApi<{ models: typeof models }>(`projects/${projectId}/models`)
        .then((r) => {
          if (alive) {
            setModels(r.models.filter((m) => m.enabled));
            setModel(r.models.find((m) => m.enabled)?.id ?? "");
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [projectId]);
  const { aiRequest, consumeAiRequest } = workspace;
  const activeFileId = workspace.active?.id;
  useEffect(() => {
    const requested = aiRequest;
    if (requested && requested.fileId === activeFileId) {
      setPrompt(requested.text);
      setTab("chat");
      consumeAiRequest(requested.id);
    }
  }, [aiRequest, activeFileId, consumeAiRequest]);
  const job = saved?.job;
  const refresh = useCallback(async () => {
    if (!job) return;
    const result = await collabApi<{ run: Run }>(`runs/${job.runId}`);
    setRun(result.run);
  }, [job]);
  useEffect(() => {
    if (!job) return;
    let alive = true,
      loading = false,
      finished = false;
    const abort = new AbortController();
    const poll = async () => {
      if (loading || finished || document.hidden) return;
      loading = true;
      try {
        const [detail, transcript] = await Promise.all([
          collabApi<{ run: Run; workspace: { directory?: string } }>(
            `runs/${job.runId}`,
            undefined,
            undefined,
            abort.signal,
          ),
          collabApi<{
            batches: { payload: { events: ChatEvent[] } }[];
            truncated: boolean;
          }>(`runs/${job.runId}/events`, undefined, undefined, abort.signal),
        ]);
        if (!alive) return;
        setRun(detail.run);
        setDirectory(detail.workspace?.directory ?? "");
        finished =
          ended.has(detail.run.status) &&
          (detail.run.status !== "completed" || saved?.candidate !== undefined);
        setTruncated(transcript.truncated);
        const rows = chatRows(transcript.batches);
        setOutput(rows);
        setSaved((s) => (s?.job?.runId === job.runId ? { ...s, rows } : s));
        if (
          detail.run.status === "completed" &&
          saved?.candidate === undefined
        ) {
          const result = await collabApi<{ status: string; text?: string }>(
            `editors/${sessionId}/conflict-agent`,
            { taskId: job.taskId, documentId },
            "PUT",
            abort.signal,
          );
          if (alive) {
            if (result.status === "ready") {
              setSaved((s) =>
                s?.job?.runId === job.runId
                  ? { ...s, candidate: result.text }
                  : s,
              );
              setNotice("");
            } else setNotice(result.status);
          }
        }
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : "读取 AI 状态失败");
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [job, sessionId, documentId, saved?.candidate]);
  async function send() {
    if (
      busy ||
      disabled ||
      !model ||
      (!prompt.trim() && !(saved && !saved.job))
    )
      return;
    const previous = saved;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const conversation: Turn[] = saved?.job
        ? [
            ...(saved.request.conversation ?? []),
            {
              role: "user",
              text: saved.request.instruction.slice(-3000),
            } as Turn,
            ...(output.length
              ? [
                  {
                    role: "assistant",
                    text: withChatInstructions(output, saved?.followups)
                      .filter((r) => r.kind !== "tool")
                      .map((r) => r.text)
                      .join("\n")
                      .slice(-3000),
                  } as Turn,
                ]
              : []),
          ].slice(-4)
        : [];
      const request =
        saved && !saved.job
          ? saved.request
          : {
              conversation,
              requestKey: crypto.randomUUID(),
              modelId: model,
              instruction: prompt.trim(),
              context: await capture(),
            };
      const history = saved?.job
        ? [
            ...(saved.history ?? []),
            {
              question: saved.request.instruction,
              rows: withChatInstructions(output, saved.followups),
              runId: saved.job.runId,
            },
          ]
        : (saved?.history ?? []);
      setSaved({ request, history });
      setRun(null);
      setDirectory("");
      setOutput([]);
      const c = request.context,
        result = await collabApi<Job>(`editors/${sessionId}/conflict-agent`, {
          documentId,
          requestKey: request.requestKey,
          modelId: request.modelId,
          instruction: request.instruction,
          conversation: request.conversation,
          revision: c.revision,
          baseToken: c.token,
          base: c.text,
          local: c.text,
          remote: c.text,
        });
      setSaved({ request, job: result, history });
      setPrompt("");
      stickToBottom.current = true;
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) {
        setSaved(previous?.job ? previous : null);
        setOutput(previous?.job ? previous.rows ?? [] : []);
        if (previous && !previous.job) setPrompt(previous.request.instruction);
      }
      setError(e instanceof Error ? e.message : "发送未确认，请重试同一请求");
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!job) return;
    setBusy(true);
    try {
      const detail = await collabApi<{ control: ControlState }>(
        `runs/${job.runId}`,
      );
      await collabApi(`runs/${job.runId}/stop`, {
        idempotencyKey: stopKey.current,
        controlVersion: detail.control.version,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "停止失败");
    } finally {
      setBusy(false);
    }
  }
  const active = !!job && (!run || !ended.has(run.status));
  async function instruct() {
    if (!job || busy || (!prompt.trim() && !instruction) || (!instruction && !["running", "waiting_input"].includes(run?.status ?? ""))) return;
    setBusy(true);
    setError("");
    try {
      const detail = await collabApi<{ control: ControlState }>(
        `runs/${job.runId}`,
      );
      const body = instruction ?? {
        expectedVersion: detail.control.version,
        kind: instructionKind,
        message: prompt.trim(),
        idempotencyKey: crypto.randomUUID(),
      };
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...saved, pendingInstruction: body }),
      );
      setInstruction(body);
      await collabApi(`runs/${job.runId}/instructions`, body);
      setSaved((s) =>
        s
          ? {
              ...s,
              pendingInstruction: undefined,
              followups: [
                ...(s.followups ?? []),
                {
                  id: body.idempotencyKey,
                  text: body.message,
                  after: output.at(-1)?.id,
                },
              ],
            }
          : s,
      );
      setInstruction(null);
      setPrompt("");
      setNotice("指令已入队；执行情况见 AI 后续回复。");
      stickToBottom.current = true;
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) setInstruction(null);
      setError(e instanceof Error ? e.message : "发送未确认，请重试同一指令");
    } finally {
      setBusy(false);
    }
  }
  function switchConversation(next: Saved | null) {
    if (active || busy || instruction || (saved && !saved.job)) return;
    const archive = [...(saved ? [saved] : []), ...archives]
      .filter(
        (item, index, all) =>
          item.request.requestKey !== next?.request.requestKey &&
          all.findIndex(
            (v) => v.request.requestKey === item.request.requestKey,
          ) === index,
      )
      .slice(0, 10);
    try {
      sessionStorage.setItem(`${key}:history`, JSON.stringify(archive));
      setArchives(archive);
      setSaved(next);
      setOutput(next?.rows ?? []);
      setRun(null);
      setPrompt("");
      setNotice("");
      setError("");
      setShowHistory(false);
    } catch {
      setError("本窗口存储空间不足，尚未切换对话；请先保留完整任务记录。");
    }
  }
  const hasCandidate =
    saved?.candidate !== undefined &&
    saved.candidate !== saved.request.context.text;
  return (
    <section className="wb-file-ai" aria-label="当前文件 AI 对话">
      <header className="wb-chat-heading">
        <strong>Pi Chat</strong>
        <button
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          对话记录
        </button>
        <button
          title="清空本窗口上下文，开始新对话；完整任务记录仍保留"
          disabled={active || busy || (!!saved && !saved.job) || !!instruction}
          onClick={() => switchConversation(null)}
        >
          ＋ 新对话
        </button>
      </header>
      {showHistory && (
        <div className="wb-chat-history">
          <p>本窗口最近 10 个对话</p>
          {archives.length ? (
            archives.map((item) => (
              <button
                disabled={
                  active || busy || !!instruction || (!!saved && !saved.job)
                }
                key={item.request.requestKey}
                onClick={() => switchConversation(item)}
              >
                {item.request.instruction.slice(0, 80)}
              </button>
            ))
          ) : (
            <p>新建对话后，之前的对话会保存在这里。</p>
          )}
        </div>
      )}
      <AiPanelTabs id={tabId} value={tab} onChange={setTab} />
      <div
        className="wb-chat-panel"
        role="tabpanel"
        id={`${tabId}-chat`}
        aria-labelledby={`${tabId}-chat-tab`}
        hidden={tab !== "chat"}
      >
        <div
          className="wb-chat-timeline"
          ref={timeline}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
          role="log"
          aria-label="文件 AI 对话消息"
          aria-live="off"
        >
          {!saved && (
            <div className="wb-chat-welcome">
              <span>✳</span>
              <h3>一起写点什么？</h3>
              <p>提问、解释代码，或描述你想做的修改。</p>
              <button
                onClick={() =>
                  setPrompt("解释这个文件的作用，指出值得改进的地方。")
                }
              >
                解释这个文件
              </button>
              <button
                onClick={() =>
                  setPrompt("检查这个文件有没有缺陷，先说明发现，再提出修改。")
                }
              >
                检查代码问题
              </button>
            </div>
          )}
          {(
            saved?.history ??
            saved?.request.conversation?.map((t) => ({
              question: t.role === "user" ? t.text : "",
              rows:
                t.role === "assistant"
                  ? [{ id: "legacy", kind: "assistant" as const, text: t.text }]
                  : [],
            })) ??
            []
          ).map((turn, i) => (
            <div key={i}>
              {turn.question && (
                <ChatMessage role="user" text={turn.question} />
              )}
              <ChatMessages rows={turn.rows} />
            </div>
          ))}
          {saved && (
            <ChatMessage role="user" text={saved.request.instruction} />
          )}
          <ChatMessages
            rows={withChatInstructions(output, saved?.followups)}
            active={active}
          />
          {active && (
            <p className="wb-chat-progress" role="status">
              <span className="wb-chat-pulse" />{" "}
              {run ? (labels[run.status] ?? run.status) : "正在连接 AI…"}
            </p>
          )}
          {run?.summary?.error && (
            <p role="alert" className="collab-error">
              {run.summary.error}
            </p>
          )}
          {truncated && (
            <p className="collab-small">
              本轮显示最近 100 批输出；更早记录见完整任务。
            </p>
          )}
          {job && run?.status === "waiting_input" && (
            <RunQuestions
              runId={job.runId}
              userId={userId}
              onChange={refresh}
            />
          )}
          {hasCandidate && saved && (
            <details className="wb-chat-change">
              <summary>
                文件修改 · {filename}
                <span>
                  {saved.applied
                    ? "已应用"
                    : saved.handedToMerge
                      ? "待解决冲突"
                      : "待检查"}
                </span>
              </summary>
              <EditorMergeDiff
                base={saved.request.context.text}
                value={saved.candidate!}
                label="AI 修改 Diff"
              />
              <button
                className="collab-button primary"
                disabled={
                  busy || disabled || saved.applied || saved.handedToMerge
                }
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void apply(saved.request.context, saved.candidate!)
                    .then((outcome) => {
                      setSaved((s) =>
                        s
                          ? {
                              ...s,
                              applied: outcome === "saved",
                              handedToMerge: outcome === "conflict",
                            }
                          : s,
                      );
                      setNotice(
                        outcome === "saved"
                          ? "已应用并保存到共享草稿。"
                          : "请在中央合并面板解决冲突后保存。",
                      );
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                {saved.handedToMerge
                  ? "已交由合并面板处理"
                  : saved.applied
                    ? "已应用到共享草稿"
                    : "检查最新版本并应用"}
              </button>
            </details>
          )}
          {job && !active && (
            <div className="wb-chat-receipt">
              <span>
                {run?.status === "completed"
                  ? hasCandidate
                    ? saved?.applied
                      ? "完成 · 修改已保存"
                      : saved?.handedToMerge
                        ? "待解决保存冲突"
                        : "修改待检查"
                    : saved?.candidate !== undefined
                      ? "完成 · 文件未改变"
                      : "正在检查文件…"
                  : run
                    ? labels[run.status]
                    : ""}
              </span>
              <a
                target="_blank"
                rel="noopener noreferrer"
                href={`/?project=${job.projectId}&task=${job.taskId}`}
              >
                完整任务 ↗
              </a>
            </div>
          )}
        </div>
        <div className="wb-chat-footer">
          {error && (
            <p role="alert" className="collab-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="wb-chat-notice">
              {notice}
            </p>
          )}
          <form
            className="wb-chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void (active || instruction ? instruct() : send());
            }}
          >
            <span className="wb-chat-context" title={filename}>
              @ {filename}
            </span>
            <textarea
              aria-label="给当前文件 AI 的需求"
              value={instruction?.message ?? prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={8000}
              rows={3}
              placeholder={
                active ? "继续对话，补充要求…" : "发消息，和 AI 一起编程…"
              }
              disabled={busy || !!instruction || (!!saved && !saved.job)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="wb-chat-composer-actions">
              <button
                type="button"
                className="wb-chat-model"
                onClick={() => setTab("settings")}
              >
                {models.find((m) => m.id === model)?.name ?? "选择模型"}⌄
              </button>
              {active && (
                <select
                  aria-label="追加消息方式"
                  value={instructionKind}
                  disabled={!!instruction}
                  onChange={(e) =>
                    setInstructionKind(e.target.value as "steer" | "follow_up")
                  }
                >
                  <option value="steer">调整方向</option>
                  <option value="follow_up">完成后继续</option>
                </select>
              )}
              {active && (
                <button
                  type="button"
                  aria-label="停止 AI"
                  title="停止 AI"
                  disabled={busy || run?.status === "stopping"}
                  onClick={() => void stop()}
                >
                  ■
                </button>
              )}
              <button
                type="submit"
                className="wb-chat-send"
                aria-label={
                  instruction || (saved && !saved.job)
                    ? "重试同一请求"
                    : "发送消息"
                }
                disabled={
                  !ready ||
                  busy ||
                  (!active && disabled && !instruction) ||
                  !model ||
                  (!prompt.trim() && !instruction && !(saved && !saved.job)) ||
                  (active &&
                    !instruction &&
                    !["running", "waiting_input"].includes(run?.status ?? ""))
                }
              >
                {busy
                  ? "…"
                  : instruction || (saved && !saved.job)
                    ? "重试"
                    : "↑"}
              </button>
            </div>
          </form>
          <p className="wb-chat-hint">
            Enter 发送 · Shift Enter 换行
            {disabled
              ? " · 当前文件只读或需先处理冲突"
              : " · AI 修改需确认后应用"}
          </p>
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-settings`}
        aria-labelledby={`${tabId}-settings-tab`}
        hidden={tab !== "settings"}
        className="collab-form compact wb-ai-settings"
      >
        <h3>工作文件夹</h3>
        <p className="collab-small">
          当前文件夹：{folder?.name ?? "正在读取…"}
          <br />
          文件：{filename}
        </p>
        <button
          type="button"
          className="collab-button"
          disabled={!workspace.canOpenFolder}
          onClick={workspace.openFolder}
        >
          打开其他工作文件夹…
        </button>
        {directory && (
          <label>
            AI 实际工作目录
            <input aria-label="AI 实际工作目录" readOnly value={directory} />
          </label>
        )}
        <h3>文件 AI 设置</h3>
        <label>
          项目模型
          <select
            aria-label="文件 AI 模型"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy || active || (!!saved && !saved.job)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <p className="collab-small">
          AI
          读取当前文件已保存的共享版本，在独立工作副本生成候选。跨文件工作请切换「项目任务」。
        </p>
        <p className="collab-small">
          对话保存在本窗口，发送最近 4
          条上下文给下一轮；完整运行记录保存在任务中。下一轮以编辑器已应用的内容为准。
        </p>
        <p className="collab-small">导入来源目录不会自动回写。</p>
        <button
          type="button"
          className="collab-button"
          onClick={() => setTab("chat")}
        >
          返回对话
        </button>
      </div>
    </section>
  );
}
