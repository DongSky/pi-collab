/**
 * 单人 Agent 自动验证闭环（对标 Codex / Cursor 的写完自测习惯）。
 *
 * 能力：当一轮 agent 回复结束且该轮写过文件时，自动发一条验证指令让
 * 同一个 agent 跑验证命令（默认自动检测 package.json 的 test/build），
 * 失败则继续修复，直到通过或达到最大轮数。命令由 agent 自己的 bash
 * 工具执行，平台本身不执行任何 shell。
 */
import { extractTurnWrittenFiles } from "./turn-written-files";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "./types";

/** 自动验证最多追加轮数（首轮验证 + 修复重试）。 */
export const AUTO_VERIFY_MAX_ROUNDS = 2;

export interface AutoVerifySettings {
  /** 是否启用；默认 true，对齐 Codex 的默认行为。 */
  enabled: boolean;
  /** 验证命令；null 表示让 agent 自动检测（如 package.json 的 test/build）。 */
  commands: string[] | null;
}

const STORAGE_KEY = "pi-web:auto-verify";
const GLOBAL_KEY = "__global__";

export const DEFAULT_AUTO_VERIFY_SETTINGS: AutoVerifySettings = { enabled: true, commands: null };

function storageKey(cwd?: string): string {
  return cwd && cwd.trim() ? cwd : GLOBAL_KEY;
}

function sanitizeSettings(raw: unknown): AutoVerifySettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AUTO_VERIFY_SETTINGS };
  const s = raw as Record<string, unknown>;
  const commands = Array.isArray(s.commands)
    ? (s.commands as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim())
    : null;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    commands: commands && commands.length > 0 ? commands : null,
  };
}

export function loadAutoVerifySettings(cwd?: string): AutoVerifySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUTO_VERIFY_SETTINGS };
    const map = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeSettings(map?.[storageKey(cwd)]);
  } catch {
    return { ...DEFAULT_AUTO_VERIFY_SETTINGS };
  }
}

export function saveAutoVerifySettings(cwd: string | undefined, settings: AutoVerifySettings): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    map[storageKey(cwd)] = { enabled: settings.enabled, commands: settings.commands };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 本地存储不可用时静默忽略，不影响主流程。
  }
}

/**
 * 构造发给 agent 的自动验证指令。
 * @param round 0 = 首轮验证，>=1 = 修复重试轮
 */
export function buildAutoVerifyPrompt(round: number, commands: string[] | null): string {
  const verifyStep = commands && commands.length > 0
    ? `依次运行以下验证命令：\n${commands.map((c, i) => `${i + 1}. \`${c}\``).join("\n")}`
    : "检查项目里的 package.json：如果有 `test` 脚本就运行 `npm test`，有 `build` 脚本就运行 `npm run build`（按项目实际使用的包管理器调整，如 pnpm/yarn）。";
  if (round <= 0) {
    return [
      "[自动验证] 请对本轮的代码修改做一次完整验收：",
      "1. 如果项目依赖尚未安装（例如缺少 node_modules），先安装依赖（如 `npm ci`）。",
      `2. ${verifyStep}`,
      "3. 如果验证失败：分析报错原因、修复代码，然后重新运行验证，直到全部通过。",
      "4. 全部通过后，用一两句话总结验证结果；如果确实无法修复，说明失败原因以及需要人工介入的地方，不要无止境重试。",
    ].join("\n");
  }
  return [
    `[自动验证 · 第 ${round + 1} 轮] 上一轮验证仍未通过，请继续定位并修复剩余问题，然后重新运行验证。`,
    "这是最后一轮自动验证：如果修不好，请总结失败原因、已尝试的修复以及需要人工介入的地方，然后停下来等待用户。",
  ].join("\n");
}

/**
 * 判断"上一条用户消息之后"的 agent 回复是否写过文件。
 * 只统计执行成功的写文件工具调用。
 */
export function lastTurnWroteFiles(
  messages: AgentMessage[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): boolean {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return false;
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = (m as AssistantMessage).content;
    if (!Array.isArray(content)) continue;
    if (extractTurnWrittenFiles(content, toolResults, cwd).length > 0) return true;
  }
  return false;
}
