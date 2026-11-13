import { ZodError } from "zod";
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof AppError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "输入格式不正确，请检查后重试。",
          details: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        },
      },
      { status: 400 },
    );
  console.error(
    "nota_request_failed",
    error instanceof Error ? error.name : "unknown",
  );
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。",
      },
    },
    { status: 500 },
  );
}
export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  const allowed = new Set([url.origin]);
  // Next may normalize the internal URL to localhost; validate the actual HTTP authority too.
  const host = request.headers.get("host");
  if (host) {
    try {
      allowed.add(new URL(`${url.protocol}//${host}`).origin);
    } catch {
      /* invalid authority is not trusted */
    }
  }
  if (process.env.APP_URL) {
    try {
      allowed.add(new URL(process.env.APP_URL).origin);
    } catch {
      /* invalid configured origin is not trusted */
    }
  }
  if (!allowed.has(origin))
    throw new AppError(403, "INVALID_ORIGIN", "请求来源不受支持。");
}
export function handler(
  fn: (request: Request) => Promise<Response>,
  mutation = false,
) {
  return async (request: Request) => {
    try {
      if (mutation) assertOrigin(request);
      return await fn(request);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
