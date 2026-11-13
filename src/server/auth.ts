import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { query, isUniqueError } from "./db";
import { AppError } from "./errors";
import type { User } from "../lib/contracts";
const scrypt = promisify(scryptCallback);
export const sessionCookie = "nota_session";
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [method, salt, hash] = stored.split(":");
  if (method !== "scrypt" || !salt || !hash) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function throttle(key: string, limit: number, seconds = 900) {
  const bucket = Math.floor(Date.now() / 1000 / seconds);
  const r = await query<{ count: number }>(
    "INSERT INTO auth_buckets(key,bucket) VALUES($1,$2) ON CONFLICT(key,bucket) DO UPDATE SET count=auth_buckets.count+1 RETURNING count",
    [sha256(key), bucket],
  );
  if (r.rows[0].count > limit)
    throw new AppError(429, "AUTH_RATE_LIMIT", "尝试过于频繁，请稍后重试。");
}
export async function register(email: string, password: string): Promise<User> {
  await throttle(`register:${email}`, 5);
  const hash = await hashPassword(password);
  try {
    const r = await query<User>(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email",
      [email, hash],
    );
    return r.rows[0];
  } catch (e) {
    if (isUniqueError(e))
      throw new AppError(409, "EMAIL_EXISTS", "此邮箱已注册，请直接登录。");
    throw e;
  }
}
export async function login(email: string, password: string): Promise<User> {
  await throttle(`login:${email}`, 10);
  const r = await query<User & { password_hash: string }>(
    "SELECT id,email,password_hash FROM users WHERE email=$1",
    [email],
  );
  const row = r.rows[0];
  const hash =
    row?.password_hash ??
    "scrypt:invalid-fixed-salt:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const valid = await verifyPassword(password, hash);
  if (!row || !valid)
    throw new AppError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确。");
  return { id: row.id, email: row.email };
}
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '14 days')",
    [sha256(token), userId],
  );
  return token;
}
export function readToken(request: Request) {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  return value && /^[A-Za-z0-9_-]{40,60}$/.test(value) ? value : null;
}
export async function currentUser(request: Request): Promise<User | null> {
  const token = readToken(request);
  if (!token) return null;
  const r = await query<User>(
    "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}
export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "请先登录。");
  return user;
}
export async function destroySession(request: Request) {
  const token = readToken(request);
  if (token)
    await query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
}
export function sessionHeader(
  request: Request,
  token: string,
  maxAge = 14 * 86400,
) {
  const secure =
    new URL(request.url).protocol === "https:" || process.env.VERCEL === "1";
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
