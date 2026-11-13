-- Capture time is separate from upload/creation time. Never infer it from text.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
UPDATE notes SET recorded_at = created_at WHERE recorded_at IS NULL;
ALTER TABLE notes ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE notes ALTER COLUMN recorded_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS notes_user_recorded_idx ON notes(user_id, recorded_at DESC);
