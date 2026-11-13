import { connection } from "next/server";
import { upgradeWebSocket } from "@vercel/functions";
import { requireUser, throttle } from "@/server/auth";
import { assertOrigin, errorResponse, AppError } from "@/server/errors";
import { quota } from "@/server/jobs";
import { bridgeAsr, maxPcmBytes, transcribePcm } from "@/server/asr";
export const maxDuration = 120;
async function authorize(request: Request) {
  assertOrigin(request);
  const user = await requireUser(request);
  if (process.env.NOTA_TEST_MODE === "1" || !process.env.DASHSCOPE_API_KEY)
    throw new AppError(503, "ASR_NOT_CONFIGURED", "语音识别尚未配置。");
  if ((await quota(user.id)).remaining < 1)
    throw new AppError(429, "DAILY_QUOTA_EXCEEDED", "今天的AI额度已用完。");
  await throttle(`asr:${user.id}`, 30, 3600);
  return user;
}
export async function GET(request: Request) {
  try {
    await connection();
    await authorize(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new AppError(426, "UPGRADE_REQUIRED", "此接口需要WebSocket连接。");
    return await upgradeWebSocket((socket) => bridgeAsr(socket), {
      maxPayload: 32 * 1024,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    await authorize(request);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > maxPcmBytes)
      throw new AppError(413, "AUDIO_TOO_LARGE", "单次录音最长60秒。");
    const pcm = Buffer.from(await request.arrayBuffer());
    return Response.json(
      { transcript: await transcribePcm(pcm), mode: "recorded" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
