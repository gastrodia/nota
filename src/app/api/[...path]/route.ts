import { z } from "zod";
import { handler, AppError } from "@/server/errors";
import { credentialsSchema } from "@/lib/contracts";
import {
  requireUser,
  currentUser,
  register,
  login,
  createSession,
  sessionHeader,
  destroySession,
  throttle,
} from "@/server/auth";
import { quota, createJob, getJob } from "@/server/jobs";
import { runJob } from "@/server/agent";
import {
  listNotes,
  getNote,
  newNote,
  deleteNote,
  listTodos,
  updateTodo,
} from "@/server/repository";
import {
  storeAudio,
  readAudio,
  cleanupAudio,
  audioConfigured,
} from "@/server/audio";
import { query } from "@/server/db";
export const maxDuration = 240;
async function json(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "INVALID_JSON", "请求内容不是有效JSON。");
  }
}
async function route(request: Request) {
  const url = new URL(request.url);
  const parts = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean);
  const path = parts.join("/");
  const method = request.method;
  if (path === "status" && method === "GET")
    return Response.json(
      {
        test_mode: process.env.NOTA_TEST_MODE === "1",
        database: Boolean(process.env.DATABASE_URL),
        model: Boolean(process.env.DASHSCOPE_API_KEY),
        audio_storage: audioConfigured(),
        asr:
          process.env.NOTA_TEST_MODE !== "1" &&
          Boolean(
            process.env.DASHSCOPE_ASR_API_KEY || process.env.DASHSCOPE_API_KEY,
          ),
        websocket_environment:
          process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  if (path === "me" && method === "GET") {
    const user = await currentUser(request);
    return Response.json(
      { user, quota: user ? await quota(user.id) : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    (path === "auth/register" || path === "auth/login") &&
    method === "POST"
  ) {
    const input = credentialsSchema.parse(await json(request));
    if (path.endsWith("register"))
      await throttle(
        `register-ip:${request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"}`,
        15,
        3600,
      );
    const user = path.endsWith("register")
      ? await register(input.email, input.password)
      : await login(input.email, input.password);
    const token = await createSession(user.id);
    return Response.json(
      { user, quota: await quota(user.id) },
      {
        status: path.endsWith("register") ? 201 : 200,
        headers: {
          "Set-Cookie": sessionHeader(request, token),
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (path === "auth/logout" && method === "POST") {
    await destroySession(request);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionHeader(request, "", 0) } },
    );
  }
  const user = await requireUser(request);
  const id = parts[1] ? z.string().uuid().parse(parts[1]) : null;
  if (path === "notes" && method === "GET") {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(url.searchParams.get("offset") ?? 0);
    return Response.json(
      {
        notes: await listNotes(
          user.id,
          (url.searchParams.get("q") ?? "").slice(0, 200),
          offset,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (path === "notes" && method === "POST")
    return Response.json(
      { note: await newNote(user.id, await json(request)) },
      { status: 201 },
    );
  if (parts[0] === "notes" && id && parts.length === 2 && method === "GET")
    return Response.json(
      { note: await getNote(user.id, id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  if (parts[0] === "notes" && id && parts.length === 2 && method === "DELETE") {
    await deleteNote(user.id, id);
    await cleanupAudio(5);
    return Response.json({ ok: true });
  }
  if (
    parts[0] === "notes" &&
    id &&
    parts[2] === "audio" &&
    parts.length === 3
  ) {
    if (method === "GET")
      return readAudio(user.id, id, request.headers.get("range"));
    if (method === "POST") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 4.3 * 1024 * 1024)
        throw new AppError(413, "AUDIO_TOO_LARGE", "录音文件超过4MB。");
      const form = await request.formData();
      const file = form.get("audio");
      if (!(file instanceof File))
        throw new AppError(400, "MISSING_AUDIO", "缺少录音文件。");
      return Response.json(await storeAudio(user.id, id, file));
    }
  }
  if (path === "todos" && method === "GET")
    return Response.json(
      { todos: await listTodos(user.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  if (parts[0] === "todos" && id && parts.length === 2 && method === "PATCH")
    return Response.json({
      todo: await updateTodo(user.id, id, await json(request)),
    });
  if (path === "jobs" && method === "POST") {
    const created = await createJob(user.id, await json(request));
    return Response.json(
      { job: await getJob(user.id, created.id), reused: created.reused },
      { status: created.reused ? 200 : 201 },
    );
  }
  if (path === "jobs" && method === "GET") {
    const conversation = z
      .string()
      .uuid()
      .parse(url.searchParams.get("conversation_id"));
    const r = await query(
      "SELECT id FROM jobs WHERE user_id=$1 AND conversation_id=$2 AND kind='chat' ORDER BY created_at DESC LIMIT 20",
      [user.id, conversation],
    );
    return Response.json(
      {
        jobs: await Promise.all(
          r.rows.reverse().map((row) => getJob(user.id, row.id)),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (parts[0] === "jobs" && id && parts.length === 2 && method === "GET")
    return Response.json(
      { job: await getJob(user.id, id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  if (
    parts[0] === "jobs" &&
    id &&
    parts[2] === "run" &&
    parts.length === 3 &&
    method === "POST"
  ) {
    await runJob(user.id, id);
    return Response.json({ job: await getJob(user.id, id) });
  }
  throw new AppError(404, "NOT_FOUND", "接口不存在。");
}
export const GET = handler(route);
export const POST = handler(route, true);
export const PATCH = handler(route, true);
export const DELETE = handler(route, true);
