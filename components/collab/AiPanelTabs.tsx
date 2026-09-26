"use client";
import type { KeyboardEvent } from "react";

export type AiPanelTab = "chat" | "settings";
export function AiPanelTabs({ id, value, onChange }: { id: string; value: AiPanelTab; onChange: (tab: AiPanelTab) => void }) {
  const tabs = [{ id: "chat", label: "对话" }, { id: "settings", label: "设置" }] as const;
  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "chat" : event.key === "End" ? "settings" : value === "chat" ? "settings" : "chat";
    onChange(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  }
  return <div className="wb-ai-view-tabs" role="tablist" aria-label="AI 面板内容">
    {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={`${id}-${tab.id}-tab`} aria-controls={`${id}-${tab.id}`} aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1} onKeyDown={navigate} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>;
}
