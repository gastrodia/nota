import { createHash, timingSafeEqual } from "node:crypto";
import { drainJobs } from "@/server/worker";
import { cleanupAudio } from "@/server/audio";
import { AppError, errorResponse } from "@/server/errors";

export const maxDuration = 240;

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret)
      throw new AppError(503, "WORKER_NOT_CONFIGURED", "后台调度尚未配置。");
    const actual = createHash("sha256")
      .update(request.headers.get("authorization") ?? "")
      .digest();
    const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
    if (!timingSafeEqual(actual, expected))
      throw new AppError(401, "UNAUTHORIZED", "后台调度凭据无效。");
    const result = await drainJobs({ limit: 2 });
    await cleanupAudio(10);
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = GET;
