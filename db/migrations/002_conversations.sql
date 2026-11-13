ALTER TABLE jobs ADD COLUMN IF NOT EXISTS conversation_id uuid;
CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(user_id,conversation_id,created_at);
