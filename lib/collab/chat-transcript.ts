/** Public, redacted run events only. Private reasoning is never a chat message. */
export type ChatEvent = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: { text?: string }[];
  message?: {
    role: string;
    content?: { text?: string }[];
    errorMessage?: string;
  };
};
export type ChatRow = {
  id: string;
  kind: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  pending?: boolean;
  failed?: boolean;
};
export function chatRows(
  batches: { payload: { events: ChatEvent[] } }[],
): ChatRow[] {
  const rows: ChatRow[] = [],
    tools = new Map<string, ChatRow>();
  let draft: ChatRow | undefined;
  const flush = () => {
    if (draft && !draft.text) rows.splice(rows.indexOf(draft), 1);
    draft = undefined;
  };
  for (const batch of batches)
    for (const event of batch.payload.events) {
      if (event.type === "assistant_text") {
        if (!draft) {
          draft = {
            id: `text-${rows.length}`,
            kind: "assistant",
            text: "",
            pending: true,
          };
          rows.push(draft);
        }
        draft.text += event.text ?? "";
      } else if (
        event.type === "message_end" &&
        event.message?.role === "assistant"
      ) {
        const text =
          event.message.content?.map((b) => b.text ?? "").join("") ||
          event.message.errorMessage ||
          "";
        if (draft) {
          draft.text = text || draft.text;
          draft.pending = false;
        } else if (text)
          rows.push({ id: `text-${rows.length}`, kind: "assistant", text });
        flush();
      } else if (event.type === "tool_execution_start") {
        flush();
        const row: ChatRow = {
          id: `tool-${event.toolCallId ?? rows.length}`,
          kind: "tool",
          name: event.toolName ?? "工具",
          text: "",
          pending: true,
        };
        rows.push(row);
        if (event.toolCallId) tools.set(event.toolCallId, row);
      } else if (event.type === "tool_execution_end") {
        const row = event.toolCallId ? tools.get(event.toolCallId) : undefined;
        const result: ChatRow = {
          id: row?.id ?? `tool-${rows.length}`,
          kind: "tool",
          name: event.toolName ?? row?.name ?? "工具",
          text: event.content?.map((b) => b.text ?? "").join("\n") ?? "",
          failed: event.isError,
          pending: false,
        };
        if (row) Object.assign(row, result);
        else rows.push(result);
      }
    }
  return rows;
}

export type ChatInstruction = { id: string; text: string; after?: string };
export function withChatInstructions(
  rows: ChatRow[],
  instructions: ChatInstruction[] = [],
): ChatRow[] {
  const result: ChatRow[] = [];
  const append = (after?: string) => {
    for (const item of instructions.filter((i) => i.after === after))
      result.push({ id: item.id, kind: "user", text: item.text });
  };
  append();
  for (const row of rows) {
    result.push(row);
    append(row.id);
  }
  for (const item of instructions.filter(
    (i) => i.after && !rows.some((r) => r.id === i.after),
  ))
    result.push({ id: item.id, kind: "user", text: item.text });
  return result;
}
