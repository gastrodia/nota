-- Preserve historical jobs and side effects. Only the original task for each
-- recording receives the business identity; old duplicate rows are retained for
-- inspection rather than silently deleted or refunded by a schema migration.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS business_key text;
WITH original AS (
  SELECT DISTINCT ON (user_id,note_id) id,note_id
  FROM jobs
  WHERE kind='note' AND note_id IS NOT NULL
  ORDER BY user_id,note_id,created_at,id
)
UPDATE jobs j SET business_key='note:'||o.note_id::text
FROM original o WHERE j.id=o.id AND j.business_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_user_business_key_key
  ON jobs(user_id,business_key);

-- All retry keys (including a new key replaying the same recording) retain their
-- original payload binding. Reusing an alias for different input must still fail.
CREATE TABLE IF NOT EXISTS job_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,idempotency_key)
);
INSERT INTO job_requests(user_id,idempotency_key,input_hash,job_id)
SELECT user_id,idempotency_key,input_hash,id FROM jobs
ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS job_requests_job_idx ON job_requests(job_id);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status,updated_at)
WHERE status IN ('pending','running','failed');
