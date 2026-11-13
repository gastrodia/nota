import { put, get, del } from "@vercel/blob";
import { query, transaction } from "./db";
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
    await del(path, { abortSignal: AbortSignal.timeout(10000) });
  },
};
export function audioConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
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
  const owner = await query(
    "SELECT status FROM notes WHERE id=$1 AND user_id=$2",
    [noteId, userId],
  );
  if (!owner.rows[0]) throw new AppError(404, "NOTE_NOT_FOUND", "便签不存在。");
  if (owner.rows[0].status !== "draft")
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
    await transaction(async (c) => {
      const n = await c.query(
        "SELECT status FROM notes WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [noteId, userId],
      );
      if (!n.rows[0] || n.rows[0].status !== "draft")
        throw new AppError(
          409,
          "NOTE_ALREADY_SUBMITTED",
          "便签已提交，音频未替换。",
        );
      const old = await c.query(
        "SELECT pathname FROM audio_assets WHERE note_id=$1",
        [noteId],
      );
      await c.query(
        "INSERT INTO audio_assets(note_id,user_id,pathname,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(note_id) DO UPDATE SET pathname=excluded.pathname,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes",
        [noteId, userId, blob.pathname, type, file.size],
      );
      if (old.rows[0])
        await c.query(
          "INSERT INTO blob_deletions(pathname) VALUES($1) ON CONFLICT DO NOTHING",
          [old.rows[0].pathname],
        );
    });
  } catch (error) {
    await query(
      "INSERT INTO blob_deletions(pathname) VALUES($1) ON CONFLICT DO NOTHING",
      [blob.pathname],
    );
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
  const r = await query(
    "SELECT a.pathname FROM audio_assets a JOIN notes n ON n.id=a.note_id WHERE n.id=$1 AND n.user_id=$2 AND a.user_id=$2",
    [noteId, userId],
  );
  if (!r.rows[0]) throw new AppError(404, "AUDIO_NOT_FOUND", "音频不存在。");
  const stored = await storage.read(r.rows[0].pathname);
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
  const rows = await query(
    "SELECT pathname FROM blob_deletions ORDER BY created_at LIMIT $1",
    [limit],
  );
  for (const row of rows.rows) {
    try {
      await storage.remove(row.pathname);
      await query("DELETE FROM blob_deletions WHERE pathname=$1", [
        row.pathname,
      ]);
    } catch {
      await query(
        "UPDATE blob_deletions SET attempts=attempts+1,last_error='storage_delete_failed' WHERE pathname=$1",
        [row.pathname],
      );
    }
  }
}
