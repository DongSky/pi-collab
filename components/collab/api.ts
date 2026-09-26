export class CollabApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export async function collabApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/collab/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new CollabApiError(result.message ?? "请求失败，请稍后重试。", response.status, result.error ?? "request_failed");
  return result;
}
