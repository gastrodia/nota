import { z } from "zod";
import { query, transaction } from "./db";
import { AppError } from "./errors";
export async function listNotes(userId: string, search = "", offset = 0) {
  const escaped = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  const r = await query(
    "SELECT n.*,EXISTS(SELECT 1 FROM audio_assets a WHERE a.note_id=n.id) AS has_audio FROM notes n WHERE user_id=$1 AND (title||' '||transcript||' '||summary) ILIKE $2 ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET $3",
    [userId, escaped, offset],
  );
  return r.rows;
}
export async function getNote(userId: string, id: string) {
  const r = await query(
    "SELECT n.*,EXISTS(SELECT 1 FROM audio_assets a WHERE a.note_id=n.id) AS has_audio FROM notes n WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  if (!r.rows[0]) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
  const todos = await query(
    "SELECT id,title,due_at,completed,note_id,source_text,created_at FROM todos WHERE user_id=$1 AND note_id=$2 ORDER BY created_at",
    [userId, id],
  );
  const jobs = await query(
    "SELECT id,status,error FROM jobs WHERE user_id=$1 AND note_id=$2 ORDER BY created_at DESC LIMIT 1",
    [userId, id],
  );
  return { ...r.rows[0], todos: todos.rows, job: jobs.rows[0] ?? null };
}
export async function newNote(userId: string, raw: unknown) {
  const input = z
    .object({
      id: z.string().uuid().optional(),
      transcript: z.string().max(10000).default(""),
      source: z.enum(["voice", "text"]).default("voice"),
      duration_seconds: z.number().int().min(0).max(60).optional(),
    })
    .parse(raw);
  const r = await query(
    "INSERT INTO notes(id,user_id,transcript,source,duration_seconds) VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING *",
    [
      input.id ?? null,
      userId,
      input.transcript,
      input.source,
      input.duration_seconds ?? null,
    ],
  );
  if (r.rows[0]) return r.rows[0];
  const existing = await query(
    "SELECT * FROM notes WHERE id=$1 AND user_id=$2",
    [input.id, userId],
  );
  if (!existing.rows[0])
    throw new AppError(409, "NOTE_ID_CONFLICT", "便签标识冲突，请重新提交。");
  return existing.rows[0];
}
export async function deleteNote(userId: string, id: string) {
  await transaction(async (c) => {
    const n = await c.query(
      "SELECT id FROM notes WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [userId, id],
    );
    if (!n.rowCount) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
    const active = await c.query(
      "SELECT 1 FROM jobs WHERE note_id=$1 AND status IN ('running','pending') LIMIT 1",
      [id],
    );
    if (active.rowCount)
      throw new AppError(
        409,
        "NOTE_PROCESSING",
        "便签正在处理中，请结束后再删除。",
      );
    await c.query(
      "INSERT INTO blob_deletions(pathname) SELECT pathname FROM audio_assets WHERE note_id=$1 ON CONFLICT DO NOTHING",
      [id],
    );
    await c.query("DELETE FROM todos WHERE note_id=$1 AND user_id=$2", [
      id,
      userId,
    ]);
    await c.query("DELETE FROM jobs WHERE note_id=$1 AND user_id=$2", [
      id,
      userId,
    ]);
    await c.query("DELETE FROM notes WHERE id=$1 AND user_id=$2", [id, userId]);
  });
}
export async function listTodos(userId: string) {
  return (
    await query(
      "SELECT id,title,due_at,completed,note_id,source_text,created_at FROM todos WHERE user_id=$1 ORDER BY completed,created_at DESC LIMIT 100",
      [userId],
    )
  ).rows;
}
export async function updateTodo(userId: string, id: string, raw: unknown) {
  const input = z.object({ completed: z.boolean() }).strict().parse(raw);
  const r = await query(
    "UPDATE todos SET completed=$1,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id,title,due_at,completed,note_id,source_text,created_at",
    [input.completed, id, userId],
  );
  if (!r.rows[0]) throw new AppError(404, "TODO_NOT_FOUND", "待办不存在。");
  return r.rows[0];
}
