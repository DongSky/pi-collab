import path from "node:path";
import { z } from "zod";
import { asUser } from "../database";
import { DomainError } from "../policy";
import { TaskPushHistoryReader } from "./task-push-history";
import { pushHistoryQuery, pushHistoryDownloadQuery, type PushPreviewDetail } from "./push-preview-schema";

const gate = Symbol.for("pi-collab:push-history-readers");
const slots = globalThis as typeof globalThis & { [gate]?: { active: number } };
export async function withTaskPushHistory<T>(userId: string, previewId: string, requestedHash: string,
  operation: (reader: TaskPushHistoryReader) => Promise<T>, external?: AbortSignal) {
  z.uuid().parse(previewId); const capacity = slots[gate] ??= { active: 0 };
  if (capacity.active >= 2) throw new DomainError("code_reader_busy", "出站历史正在读取，请稍后重试。", 429);
  capacity.active++;
  try {
    return await asUser(userId, async db => {
      const scope = async () => (await db.query<{ result: PushPreviewDetail }>("SELECT collab.task_push_preview_detail($1) AS result", [previewId])).rows[0].result;
      const before = await scope();
      if (before.status !== "ready" || !before.manifestHash) throw new DomainError("task_push_history_unavailable", "需要已完成的推送预览。", 409);
      if (before.manifestHash !== requestedHash) throw new DomainError("task_push_history_stale", "出站历史版本不匹配，请重新打开原预览。", 409);
      const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(20000)]);
      let value: T;
      try {
        const reader = await TaskPushHistoryReader.open(process.env.PI_COLLAB_DATA_DIR ?? path.resolve(".local"), previewId, before.manifestHash, signal);
        if (reader.identity.runId !== before.runId || reader.identity.head !== before.head || reader.identity.repositoryId !== before.binding.repositoryId) throw new Error("identity_mismatch");
        value = await operation(reader);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("task_push_history_unavailable", "固定出站历史读取失败、已损坏或已取消，请重新检查原预览。", 409);
      }
      // READ COMMITTED checks current project access again after reading bytes.
      // Neither a ready export nor a cached manifest grants continued access.
      const after = await scope();
      if (signal.aborted || after.status !== "ready" || after.manifestHash !== before.manifestHash) throw new DomainError("task_push_history_stale", "出站历史状态已经变化，请重新读取。", 409);
      return value;
    });
  } finally { capacity.active--; }
}
export function taskPushHistory(userId: string, previewId: string, raw: unknown, signal?: AbortSignal) {
  const query = pushHistoryQuery.parse(raw);
  return withTaskPushHistory(userId, previewId, query.manifestHash, reader => reader.read(query), signal);
}
export function taskPushHistoryDownload(userId: string, previewId: string, raw: unknown, signal?: AbortSignal) {
  const query = pushHistoryDownloadQuery.parse(raw);
  return withTaskPushHistory(userId, previewId, query.manifestHash, reader => reader.download(query), signal);
}
