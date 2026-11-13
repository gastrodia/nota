import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, sql } from "drizzle-orm";
import { orm, isUniqueError } from "./db";
import { authBuckets, sessions, users } from "./schema";
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
  const [row] = await orm()
    .insert(authBuckets)
    .values({ key: sha256(key), bucket })
    .onConflictDoUpdate({
      target: [authBuckets.key, authBuckets.bucket],
      set: { count: sql`${authBuckets.count} + 1` },
    })
    .returning({ count: authBuckets.count });
  if (row.count > limit)
    throw new AppError(429, "AUTH_RATE_LIMIT", "尝试过于频繁，请稍后重试。");
}
export async function register(email: string, password: string): Promise<User> {
  await throttle(`register:${email}`, 5);
  const hash = await hashPassword(password);
  try {
    const [user] = await orm()
      .insert(users)
      .values({ email, password_hash: hash })
      .returning({ id: users.id, email: users.email });
    return user;
  } catch (e) {
    if (isUniqueError(e))
      throw new AppError(409, "EMAIL_EXISTS", "此邮箱已注册，请直接登录。");
    throw e;
  }
}
export async function login(email: string, password: string): Promise<User> {
  await throttle(`login:${email}`, 10);
  const [row] = await orm()
    .select({
      id: users.id,
      email: users.email,
      password_hash: users.password_hash,
    })
    .from(users)
    .where(eq(users.email, email));
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
  await orm()
    .insert(sessions)
    .values({
      token_hash: sha256(token),
      user_id: userId,
      expires_at: sql`now() + interval '14 days'`,
    });
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
  const [user] = await orm()
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.user_id))
    .where(
      and(
        eq(sessions.token_hash, sha256(token)),
        gt(sessions.expires_at, sql`now()`),
      ),
    );
  return user ?? null;
}
export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "请先登录。");
  return user;
}
export async function destroySession(request: Request) {
  const token = readToken(request);
  if (token)
    await orm()
      .delete(sessions)
      .where(eq(sessions.token_hash, sha256(token)));
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
