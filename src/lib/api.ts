export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiFailure(
      "网络连接失败，请保留当前内容后重试。",
      0,
      "NETWORK_ERROR",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiFailure(
      data.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      data.error?.code ?? "REQUEST_FAILED",
    );
  return data as T;
}
export interface PendingOperation {
  fingerprint: string;
  idempotency_key: string;
  note_id?: string;
  audio_uploaded?: boolean;
  job_id?: string;
}
export function pendingOperation(
  userId: string,
  kind: string,
  fingerprint: string,
): PendingOperation {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`nota:operation:${userId}:${kind}`) ?? "null",
    );
    if (
      saved?.fingerprint === fingerprint &&
      typeof saved.idempotency_key === "string"
    )
      return saved;
  } catch {}
  const operation = { fingerprint, idempotency_key: crypto.randomUUID() };
  saveOperation(userId, kind, operation);
  return operation;
}
export function saveOperation(
  userId: string,
  kind: string,
  operation: PendingOperation,
) {
  try {
    localStorage.setItem(
      `nota:operation:${userId}:${kind}`,
      JSON.stringify(operation),
    );
  } catch {
    throw new ApiFailure(
      "浏览器无法保存重试标识，请允许本地存储后重试。",
      0,
      "STORAGE_UNAVAILABLE",
    );
  }
}
export function clearOperation(userId: string, kind: string) {
  try {
    localStorage.removeItem(`nota:operation:${userId}:${kind}`);
  } catch {}
}
