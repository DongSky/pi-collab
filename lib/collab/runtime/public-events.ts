import { OutputRedactor, redactOutput } from "./output-redaction.mjs";
const text = (value: unknown, limit = 32_000) => typeof value === "string" ? redactOutput(value.slice(0, limit)) : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function content(value: unknown) {
  if (!Array.isArray(value)) return [];
  let remaining = 32_000;
  const blocks = value.slice(0, 50).flatMap(item => {
    const block = record(item);
    if (block.type === "text" && remaining > 0) {
      const visible = typeof block.text === "string" ? block.text.slice(0, remaining) : ""; remaining -= visible?.length ?? 0;
      return [{ type: "text", text: visible, truncated: typeof block.text === "string" && block.text.length > (visible?.length ?? 0) }];
    }
    // Thinking blocks, signatures, images and provider-private payloads are not collaboration events.
    return [];
  });
  // Concatenate before filtering: separate text blocks are not secret boundaries.
  return blocks.length ? [{ type: "text", text: redactOutput(blocks.map(b => b.text).join("")), truncated: blocks.some(b => b.truncated) }] : [];
}

/** Persist only visible bounded output, not private reasoning or raw get_state/session paths. */
type Filters = { assistant: OutputRedactor; terminal: OutputRedactor };
/** One filter per running process; never share partial tokens across users/runs. */
export function createPublicEventFilter() {
  const filters: Filters = { assistant: new OutputRedactor(), terminal: new OutputRedactor() };
  return (event: Record<string, unknown>) => publicRpcEvent(event, filters);
}
export function publicRpcEvent(event: Record<string, unknown>, filters: Filters = { assistant: new OutputRedactor(), terminal: new OutputRedactor() }): Record<string, unknown> | null {
  const type = event.type;
  if(type === "terminal_output")return {type,text:filters.terminal.push(typeof event.text === "string" ? event.text : "").slice(0,64000)};
  if(type === "terminal_resize" && Number.isInteger(event.cols) && Number.isInteger(event.rows))return {type,cols:event.cols,rows:event.rows};
  if(type === "terminal_exit")return {type,exitCode:typeof event.exitCode==="number"?event.exitCode:null};
  if (type === "message_update") {
    const update = record(event.assistantMessageEvent);
    return update.type === "text_delta" ? { type: "assistant_text", text: filters.assistant.push(typeof update.delta === "string" ? update.delta : "").slice(0,32000) } : null;
  }
  if (type === "message_end") {
    filters.assistant = new OutputRedactor();
    const message = record(event.message);
    if (!["assistant", "user", "toolResult"].includes(String(message.role))) return null;
    return { type, message: { role: message.role, content: content(message.content), stopReason: text(message.stopReason, 30), errorMessage: text(message.errorMessage, 1000), toolCallId: text(message.toolCallId, 150) } };
  }
  if (type === "tool_execution_start") return { type, toolName: text(event.toolName, 150), toolCallId: text(event.toolCallId, 150) };
  if (type === "tool_execution_end") return { type, toolName: text(event.toolName, 150), toolCallId: text(event.toolCallId, 150), isError: event.isError === true, content: content(record(event.result).content) };
  if (["agent_start", "agent_settled", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end"].includes(String(type))) return { type };
  return null;
}
