import { put, get, del } from "@vercel/blob";
import { and, asc, eq, sql } from "drizzle-orm";
import { orm, ormTransaction } from "./db";
import { audioAssets, blobDeletions, notes } from "./schema";
import { AppError } from "./errors";
const maxBytes = 4 * 1024 * 1024;
export interface AudioStorage {
  write(path: string, file: File, type: string): Promise<{ pathname: string }>;
  read(path: string): Promise<{
    stream: ReadableStream;
    contentType: string;
    size: number;
  } | null>;
  remove(path: string): Promise<void>;
}
const privateStorage: AudioStorage = {
  async write(path, file, contentType) {
    try {
      return await put(path, file, {
        access: "private",
        token: process.env.BLOB_READ_WRITE_TOKEN || undefined,
        addRandomSuffix: true,
        contentType,
        abortSignal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new AppError(
        502,
        "AUDIO_UPLOAD_FAILED",
        "原始录音保存失败，请保留当前录音后重试。",
      );
    }
  },
  async read(path) {
    try {
      const result = await get(path, {
        access: "private",
        token: process.env.BLOB_READ_WRITE_TOKEN || undefined,
        useCache: false,
        abortSignal: AbortSignal.timeout(30000),
      });
      return result?.statusCode === 200
        ? {
            stream: result.stream,
            contentType: result.blob.contentType,
            size: result.blob.size,
          }
        : null;
    } catch {
      throw new AppError(
        502,
        "AUDIO_READ_FAILED",
        "原始录音暂时无法读取，请稍后重试。",
      );
    }
  },
  async remove(path) {
    await del(path, {
      token: process.env.BLOB_READ_WRITE_TOKEN || undefined,
      abortSignal: AbortSignal.timeout(10000),
    });
  },
};
export function audioConfigured() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
    (process.env.BLOB_STORE_ID?.trim() &&
      (process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.VERCEL === "1")),
  );
}
function requireStorage() {
  if (!audioConfigured())
    throw new AppError(
      503,
      "AUDIO_STORAGE_NOT_CONFIGURED",
      "私有音频存储尚未配置。",
    );
}
export async function storeAudio(
  userId: string,
  noteId: string,
  file: File,
  storage: AudioStorage = privateStorage,
) {
  requireStorage();
  if (file.size < 1 || file.size > maxBytes)
    throw new AppError(413, "AUDIO_TOO_LARGE", "录音文件必须小于4MB。");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const signature = Buffer.from(head).toString("ascii");
  let type: string;
  let extension: string;
  if (
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    type = "audio/webm";
    extension = "webm";
  } else if (signature.slice(4, 8) === "ftyp") {
    type = "audio/mp4";
    extension = "m4a";
  } else if (signature.startsWith("OggS")) {
    type = "audio/ogg";
    extension = "ogg";
  } else if (
    signature.startsWith("RIFF") &&
    signature.slice(8, 12) === "WAVE"
  ) {
    type = "audio/wav";
    extension = "wav";
  } else throw new AppError(400, "INVALID_AUDIO", "不支持此录音格式。");
  const [owner] = await orm()
    .select({ status: notes.status })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, userId)));
  if (!owner) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
  if (owner.status !== "draft")
    throw new AppError(
      409,
      "NOTE_ALREADY_SUBMITTED",
      "便签已提交，不能替换原始音频。",
    );
  const blob = await storage.write(
    `audio/${userId}/${noteId}.${extension}`,
    file,
    type,
  );
  try {
    await ormTransaction(async (db) => {
      const [note] = await db
        .select({ status: notes.status })
        .from(notes)
        .where(and(eq(notes.id, noteId), eq(notes.user_id, userId)))
        .for("update");
      if (!note || note.status !== "draft")
        throw new AppError(
          409,
          "NOTE_ALREADY_SUBMITTED",
          "便签已提交，音频未替换。",
        );
      const [old] = await db
        .select({ pathname: audioAssets.pathname })
        .from(audioAssets)
        .where(eq(audioAssets.note_id, noteId));
      const asset = {
        pathname: blob.pathname,
        mime_type: type,
        size_bytes: file.size,
      };
      await db
        .insert(audioAssets)
        .values({ note_id: noteId, user_id: userId, ...asset })
        .onConflictDoUpdate({ target: audioAssets.note_id, set: asset });
      if (old)
        await db
          .insert(blobDeletions)
          .values({ pathname: old.pathname })
          .onConflictDoNothing();
    });
  } catch (error) {
    await orm()
      .insert(blobDeletions)
      .values({ pathname: blob.pathname })
      .onConflictDoNothing();
    throw error;
  }
  return { saved: true, size: file.size, mime_type: type };
}
export async function readAudio(
  userId: string,
  noteId: string,
  range: string | null = null,
  storage: AudioStorage = privateStorage,
) {
  requireStorage();
  const [asset] = await orm()
    .select({ pathname: audioAssets.pathname })
    .from(audioAssets)
    .innerJoin(notes, eq(notes.id, audioAssets.note_id))
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.user_id, userId),
        eq(audioAssets.user_id, userId),
      ),
    );
  if (!asset) throw new AppError(404, "AUDIO_NOT_FOUND", "音频不存在。");
  const stored = await storage.read(asset.pathname);
  if (!stored) throw new AppError(404, "AUDIO_NOT_FOUND", "音频不存在。");
  const headers = new Headers({
    "Content-Type": stored.contentType,
    "Content-Length": String(stored.size),
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  // Single-range media requests; unsupported multipart syntax falls back to 200.
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, stored.size - Number(match[2]));
    const end =
      match[1] && match[2]
        ? Math.min(Number(match[2]), stored.size - 1)
        : stored.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= stored.size
    ) {
      void stored.stream.cancel().catch(() => {});
      headers.set("Content-Range", `bytes */${stored.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    // Short originals are capped at 4 MiB, so bounded buffering also supports suffix ranges.
    const bytes = await new Response(stored.stream).arrayBuffer();
    headers.set("Content-Range", `bytes ${start}-${end}/${stored.size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  }
  return new Response(stored.stream, { headers });
}
export async function cleanupAudio(
  limit = 10,
  storage: AudioStorage = privateStorage,
) {
  if (!audioConfigured()) return;
  const rows = await orm()
    .select({ pathname: blobDeletions.pathname })
    .from(blobDeletions)
    .orderBy(asc(blobDeletions.created_at))
    .limit(limit);
  for (const row of rows) {
    try {
      await storage.remove(row.pathname);
      await orm()
        .delete(blobDeletions)
        .where(eq(blobDeletions.pathname, row.pathname));
    } catch {
      await orm()
        .update(blobDeletions)
        .set({
          attempts: sql`${blobDeletions.attempts} + 1`,
          last_error: "storage_delete_failed",
        })
        .where(eq(blobDeletions.pathname, row.pathname));
    }
  }
}
