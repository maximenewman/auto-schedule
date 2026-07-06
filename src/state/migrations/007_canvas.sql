-- Canvas LMS becomes the primary source. Users paste a personal access token
-- (Canvas -> Account -> Settings -> New access token); subjects created from
-- Canvas courses are linked via canvas_course_id so re-syncs match instead of
-- duplicating.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS canvas_token            TEXT,
  ADD COLUMN IF NOT EXISTS canvas_token_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canvas_base_url         TEXT NOT NULL DEFAULT 'https://canvas.sfu.ca';

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS canvas_course_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_user_canvas_course
  ON subjects(user_id, canvas_course_id)
  WHERE canvas_course_id IS NOT NULL;
