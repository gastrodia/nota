import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  ilike,
  inArray,
  sql,
} from "drizzle-orm";
import { orm, ormTransaction } from "./db";
import { audioAssets, blobDeletions, jobs, notes, todos } from "./schema";
import { AppError } from "./errors";

const todoFields = {
  id: todos.id,
  title: todos.title,
  due_at: todos.due_at,
  completed: todos.completed,
  note_id: todos.note_id,
  source_text: todos.source_text,
  created_at: todos.created_at,
};
function noteFields() {
  return {
    ...getTableColumns(notes),
    has_audio: exists(
      orm()
        .select({ note_id: audioAssets.note_id })
        .from(audioAssets)
        .where(eq(audioAssets.note_id, notes.id)),
    ),
  };
}
export async function listNotes(userId: string, search = "", offset = 0) {
  const escaped = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  return orm()
    .select(noteFields())
    .from(notes)
    .where(
      and(
        eq(notes.user_id, userId),
        ilike(
          sql`${notes.title} || ' ' || ${notes.transcript} || ' ' || ${notes.summary}`,
          escaped,
        ),
      ),
    )
    .orderBy(desc(notes.recorded_at), desc(notes.id))
    .limit(30)
    .offset(offset);
}
export async function getNote(userId: string, id: string) {
  const [note] = await orm()
    .select(noteFields())
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.user_id, userId)));
  if (!note) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
  const noteTodos = await orm()
    .select(todoFields)
    .from(todos)
    .where(and(eq(todos.user_id, userId), eq(todos.note_id, id)))
    .orderBy(asc(todos.created_at));
  const [job] = await orm()
    .select({ id: jobs.id, status: jobs.status, error: jobs.error })
    .from(jobs)
    .where(and(eq(jobs.user_id, userId), eq(jobs.note_id, id)))
    .orderBy(desc(jobs.created_at))
    .limit(1);
  return { ...note, todos: noteTodos, job: job ?? null };
}
export async function newNote(userId: string, raw: unknown) {
  const input = z
    .object({
      id: z.string().uuid().optional(),
      transcript: z.string().max(10000).default(""),
      source: z.enum(["voice", "text"]).default("voice"),
      duration_seconds: z.number().int().min(0).max(60).optional(),
      recorded_at: z.string().datetime({ offset: true }).optional(),
    })
    .parse(raw);
  const [note] = await orm()
    .insert(notes)
    .values({
      ...input,
      recorded_at: input.recorded_at ? new Date(input.recorded_at) : undefined,
      user_id: userId,
    })
    .onConflictDoNothing({ target: notes.id })
    .returning();
  if (note) return note;
  const [existing] = input.id
    ? await orm()
        .select()
        .from(notes)
        .where(and(eq(notes.id, input.id), eq(notes.user_id, userId)))
    : [];
  if (!existing)
    throw new AppError(409, "NOTE_ID_CONFLICT", "便签标识冲突，请重新提交。");
  return existing;
}
export async function deleteNote(userId: string, id: string) {
  await ormTransaction(async (db) => {
    const [note] = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.user_id, userId), eq(notes.id, id)))
      .for("update");
    if (!note) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
    const [active] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.note_id, id), inArray(jobs.status, ["running", "pending"])),
      )
      .limit(1);
    if (active)
      throw new AppError(
        409,
        "NOTE_PROCESSING",
        "便签正在处理中，请结束后再删除。",
      );
    // Keep INSERT ... SELECT atomic while letting PostgreSQL fill queue defaults.
    await db.execute(sql`
      INSERT INTO ${blobDeletions} (pathname)
      SELECT ${audioAssets.pathname} FROM ${audioAssets} WHERE ${audioAssets.note_id} = ${id}
      ON CONFLICT DO NOTHING
    `);
    await db
      .delete(todos)
      .where(and(eq(todos.note_id, id), eq(todos.user_id, userId)));
    await db
      .delete(jobs)
      .where(and(eq(jobs.note_id, id), eq(jobs.user_id, userId)));
    await db
      .delete(notes)
      .where(and(eq(notes.id, id), eq(notes.user_id, userId)));
  });
}
export async function listTodos(userId: string) {
  return orm()
    .select(todoFields)
    .from(todos)
    .where(eq(todos.user_id, userId))
    .orderBy(asc(todos.completed), desc(todos.created_at))
    .limit(100);
}
export async function updateTodo(userId: string, id: string, raw: unknown) {
  const input = z.object({ completed: z.boolean() }).strict().parse(raw);
  const [todo] = await orm()
    .update(todos)
    .set({ completed: input.completed, updated_at: sql`now()` })
    .where(and(eq(todos.id, id), eq(todos.user_id, userId)))
    .returning(todoFields);
  if (!todo) throw new AppError(404, "TODO_NOT_FOUND", "待办不存在。");
  return todo;
}
