"use client";
import { useEffect, useState } from "react";
import { collabApi, CollabApiError } from "./api";
import type { ControlState } from "./RunControl";
export function RunChatComposer({
  runId,
  userId,
  control,
  status,
  onChange,
  onStop,
}: {
  runId: string;
  userId: string;
  control: ControlState;
  status: string;
  onChange: () => Promise<void>;
  onStop: () => void;
}) {
  const key = `pi-collab:chat-instruction:${userId}:${runId}`;
  const [prompt, setPrompt] = useState(""),
    [kind, setKind] = useState("steer"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{
    expectedVersion: string;
    kind: string;
    message: string;
    idempotencyKey: string;
  } | null>(null);
  useEffect(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (value) setPending(value);
    } catch {
      setError("无法读取未确认的发送请求，请先检查成员指令记录。");
    }
  }, [key]);
  const allowed =
    control.controllerId === userId &&
    control.valid &&
    control.instructionsOpen &&
    ["running", "waiting_input"].includes(status);
  async function send() {
    if (busy || !allowed || (!prompt.trim() && !pending)) return;
    setBusy(true);
    setError("");
    const body = pending ?? {
      expectedVersion: control.version,
      kind,
      message: prompt.trim(),
      idempotencyKey: crypto.randomUUID(),
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(body));
      setPending(body);
      await collabApi(`runs/${runId}/instructions`, body);
      sessionStorage.removeItem(key);
      setPending(null);
      setPrompt("");
      setNotice("消息已入队，AI 的后续回复会显示在对话中。");
      await onChange();
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) {
        sessionStorage.removeItem(key);
        setPending(null);
      }
      setError(e instanceof Error ? e.message : "发送未确认，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wb-chat-footer">
      {error && (
        <p role="alert" className="collab-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="wb-chat-notice" role="status">
          {notice}
        </p>
      )}
      <form
        className="wb-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="给项目 AI 发消息"
          rows={3}
          value={pending?.message ?? prompt}
          disabled={busy || !!pending || !allowed}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            allowed
              ? "继续对话，补充要求…"
              : `当前由 ${control.controllerName} 控制`
          }
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
          <select
            className="wb-chat-model"
            aria-label="项目消息方式"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            disabled={!!pending}
          >
            <option value="steer">调整当前方向</option>
            <option value="follow_up">完成后继续</option>
          </select>
          {allowed && (
            <button
              type="button"
              title="停止 AI"
              aria-label="停止项目 AI"
              onClick={onStop}
            >
              ■
            </button>
          )}
          <button
            className="wb-chat-send"
            aria-label={pending ? "重试项目消息" : "发送项目消息"}
            disabled={busy || !allowed || (!prompt.trim() && !pending)}
          >
            {pending ? "重试" : "↑"}
          </button>
        </div>
      </form>
      <p className="wb-chat-hint">Enter 发送 · Shift Enter 换行</p>
    </div>
  );
}
