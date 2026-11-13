-- One pending action can be answered by several concurrent follow-up jobs.
-- Keep the successful action identity separate from their per-job tool ledgers.
CREATE TABLE IF NOT EXISTS clarification_resolutions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_key text NOT NULL,
  args jsonb NOT NULL,
  result jsonb NOT NULL,
  todo_id uuid REFERENCES todos(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,origin_job_id)
);
