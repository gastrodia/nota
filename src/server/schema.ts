import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AgentResult } from "../lib/contracts";

// SQL migrations remain the source of truth for DDL. Keep these definitions in sync.
const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  password_hash: text().notNull(),
  created_at: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    token_hash: text().primaryKey(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires_at: timestamp({ withTimezone: true }).notNull(),
    created_at: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.user_id)],
);

export const authBuckets = pgTable(
  "auth_buckets",
  {
    key: text().notNull(),
    bucket: bigint({ mode: "number" }).notNull(),
    count: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.bucket] })],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull().default("未整理的记录"),
    transcript: text().notNull().default(""),
    summary: text().notNull().default(""),
    status: text({ enum: ["draft", "processing", "ready", "failed"] })
      .notNull()
      .default("draft"),
    source: text({ enum: ["text", "voice", "agent"] })
      .notNull()
      .default("text"),
    duration_seconds: integer(),
    recorded_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("notes_user_created_idx").on(t.user_id, t.created_at.desc()),
    index("notes_user_recorded_idx").on(t.user_id, t.recorded_at.desc()),
    check(
      "notes_status_check",
      sql`${t.status} IN ('draft','processing','ready','failed')`,
    ),
    check("notes_source_check", sql`${t.source} IN ('text','voice','agent')`),
  ],
);

export const audioAssets = pgTable(
  "audio_assets",
  {
    note_id: uuid()
      .primaryKey()
      .references(() => notes.id, { onDelete: "cascade" }),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pathname: text().notNull().unique(),
    mime_type: text().notNull(),
    size_bytes: integer().notNull(),
    created_at: createdAt(),
  },
  (t) => [check("audio_assets_size_bytes_check", sql`${t.size_bytes} > 0`)],
);

export const usageDaily = pgTable(
  "usage_daily",
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    used: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.day] }),
    check("usage_daily_used_check", sql`${t.used} >= 0 AND ${t.used} <= 10`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_hash: text().notNull(),
    business_key: text(),
    kind: text({ enum: ["note", "chat"] }).notNull(),
    input: text().notNull(),
    conversation_id: uuid(),
    note_id: uuid().references(() => notes.id, { onDelete: "set null" }),
    status: text({ enum: ["pending", "running", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    quota_day: date({ mode: "string" }).notNull(),
    quota_state: text({ enum: ["reserved", "consumed", "refunded"] })
      .notNull()
      .default("reserved"),
    attempt: integer().notNull().default(0),
    fence: integer().notNull().default(0),
    lease_until: timestamp({ withTimezone: true }),
    agent_state: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb().$type<AgentResult>(),
    error: text(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique().on(t.user_id, t.idempotency_key),
    unique("jobs_user_business_key_key").on(t.user_id, t.business_key),
    index("jobs_user_created_idx").on(t.user_id, t.created_at.desc()),
    index("jobs_queue_idx")
      .on(t.status, t.updated_at)
      .where(sql`${t.status} IN ('pending','running','failed')`),
    index("jobs_conversation_idx").on(
      t.user_id,
      t.conversation_id,
      t.created_at,
    ),
    check("jobs_kind_check", sql`${t.kind} IN ('note','chat')`),
    check(
      "jobs_status_check",
      sql`${t.status} IN ('pending','running','succeeded','failed')`,
    ),
    check(
      "jobs_quota_state_check",
      sql`${t.quota_state} IN ('reserved','consumed','refunded')`,
    ),
  ],
);

export const jobRequests = pgTable(
  "job_requests",
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotency_key: text().notNull(),
    input_hash: text().notNull(),
    job_id: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    created_at: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.idempotency_key] }),
    index("job_requests_job_idx").on(t.job_id),
  ],
);

export const todos = pgTable(
  "todos",
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note_id: uuid().references(() => notes.id, { onDelete: "set null" }),
    job_id: uuid().references(() => jobs.id, { onDelete: "set null" }),
    title: text().notNull(),
    due_at: timestamp({ withTimezone: true }),
    completed: boolean().notNull().default(false),
    source_text: text().notNull().default(""),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("todos_user_idx").on(t.user_id, t.created_at.desc())],
);

export const toolRuns = pgTable(
  "tool_runs",
  {
    job_id: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    action_key: text().notNull(),
    name: text().notNull(),
    args: jsonb().$type<Record<string, unknown>>().notNull(),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
    has_effect: boolean().notNull().default(false),
    created_at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.job_id, t.action_key] })],
);

export const clarificationResolutions = pgTable(
  "clarification_resolutions",
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    origin_job_id: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    action_key: text().notNull(),
    args: jsonb().$type<Record<string, unknown>>().notNull(),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
    todo_id: uuid().references(() => todos.id, { onDelete: "set null" }),
    created_at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.origin_job_id] })],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    job_id: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    created_at: createdAt(),
  },
  (t) => [index("job_events_job_idx").on(t.job_id, t.id)],
);

export const blobDeletions = pgTable("blob_deletions", {
  pathname: text().primaryKey(),
  attempts: integer().notNull().default(0),
  last_error: text(),
  created_at: createdAt(),
});
