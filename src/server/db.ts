import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { AppError } from "./errors";
import * as schema from "./schema";
let pool: Pool | undefined;
type OrmDatabase = NodePgDatabase<typeof schema>;
let ormDatabase: OrmDatabase | undefined;
export function database() {
  if (!process.env.DATABASE_URL)
    throw new AppError(503, "DATABASE_NOT_CONFIGURED", "数据库尚未配置。");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
  }));
}
export function orm(): OrmDatabase {
  return (ormDatabase ??= drizzle({ client: database(), schema }));
}
// Bind ORM queries to the same checked-out connection and transaction as raw SQL.
export function ormTransaction<T>(fn: (db: OrmDatabase) => Promise<T>) {
  return transaction((client) => fn(drizzle({ client, schema })));
}
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
) {
  return database().query<T>(sql, values);
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='10s'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
  ormDatabase = undefined;
}
export function isUniqueError(error: unknown) {
  // Drizzle wraps driver errors and preserves the PostgreSQL error as cause.
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    if ("code" in error && error.code === "23505") return true;
    seen.add(error);
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
