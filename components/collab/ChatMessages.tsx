"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatRow } from "@/lib/collab/chat-transcript";
export function ChatMessage({
  role,
  text,
  children,
}: {
  role: "user" | "assistant";
  text: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <article
      className={`wb-chat-message ${role}`}
      aria-label={role === "user" ? "你的消息" : "AI 消息"}
    >
      <span className="wb-chat-author">{role === "user" ? "你" : "Pi"}</span>
      <div className="wb-chat-body">
        {role === "user" ? (
          <p>{text}</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
              img: ({ alt }) => <span>[图片：{alt}]</span>,
            }}
          >
            {text}
          </ReactMarkdown>
        )}
        {children}
      </div>
      {text && (
        <button
          className="wb-chat-copy"
          title="复制消息"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                setError("");
              })
              .catch(() => setError("复制失败，请选中文本复制。"));
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      )}
      {error && <small role="alert">{error}</small>}
    </article>
  );
}
function ToolMessage({ row, active }: { row: ChatRow; active: boolean }) {
  return (
    <details className="wb-chat-tool">
      <summary>
        <span aria-hidden="true">⌘</span> {row.name}{" "}
        <small>
          {row.failed
            ? "失败"
            : row.pending
              ? active
                ? "执行中"
                : "未收到完成记录"
              : "已完成"}
        </small>
      </summary>
      <pre>{row.text || "工具结果尚未返回。"}</pre>
    </details>
  );
}
export function ChatMessages({
  rows,
  active = false,
}: {
  rows: ChatRow[];
  active?: boolean;
}) {
  const groups: ChatRow[][] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (row.kind === "tool" && last?.[0].kind === "tool") last.push(row);
    else groups.push([row]);
  }
  return (
    <>
      {groups.map((group) =>
        group[0].kind === "tool" ? (
          group.length > 1 ? (
            <details className="wb-chat-tools" key={group[0].id}>
              <summary>
                {active && group.some((r) => r.pending)
                  ? "正在使用工具"
                  : "工具操作"}{" "}
                · {group.length} 项
                {group.some((r) => r.failed) ? " · 有错误" : ""}
              </summary>
              {group.map((row) => (
                <ToolMessage key={row.id} row={row} active={active} />
              ))}
            </details>
          ) : (
            <ToolMessage key={group[0].id} row={group[0]} active={active} />
          )
        ) : (
          <ChatMessage
            key={group[0].id}
            role={group[0].kind === "user" ? "user" : "assistant"}
            text={group[0].text}
          />
        ),
      )}
    </>
  );
}
