CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
 password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_buckets (
 key text NOT NULL, bucket bigint NOT NULL, count integer NOT NULL DEFAULT 1,
 PRIMARY KEY(key,bucket)
);
CREATE TABLE IF NOT EXISTS notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL DEFAULT '未整理的记录', transcript text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','processing','ready','failed')),
 source text NOT NULL DEFAULT 'text' CHECK(source IN ('text','voice','agent')),
 duration_seconds integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_user_created_idx ON notes(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS audio_assets (
 note_id uuid PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 pathname text NOT NULL UNIQUE, mime_type text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_daily (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, day date NOT NULL,
 used integer NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=10), PRIMARY KEY(user_id,day)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL, input_hash text NOT NULL, kind text NOT NULL CHECK(kind IN ('note','chat')),
 input text NOT NULL, conversation_id uuid, note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed')),
 quota_day date NOT NULL, quota_state text NOT NULL DEFAULT 'reserved' CHECK(quota_state IN ('reserved','consumed','refunded')),
 attempt integer NOT NULL DEFAULT 0, fence integer NOT NULL DEFAULT 0, lease_until timestamptz,
 agent_state jsonb NOT NULL DEFAULT '{}', result jsonb, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS todos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 note_id uuid REFERENCES notes(id) ON DELETE SET NULL, job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 title text NOT NULL, due_at timestamptz, completed boolean NOT NULL DEFAULT false,
 source_text text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todos_user_idx ON todos(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS tool_runs (
 job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, action_key text NOT NULL,
 name text NOT NULL, args jsonb NOT NULL, result jsonb NOT NULL,
 has_effect boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,action_key)
);
CREATE TABLE IF NOT EXISTS job_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id,id);
CREATE TABLE IF NOT EXISTS blob_deletions (
 pathname text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
