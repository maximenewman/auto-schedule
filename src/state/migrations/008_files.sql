-- Canvas course files mirrored into object storage (Tigris). One row per
-- (user, canvas file); canvas_updated_at powers the re-pull dedup — a file
-- is only downloaded again when Canvas reports a newer version.

CREATE TABLE IF NOT EXISTS files (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_file_id    BIGINT  NOT NULL,
  subject_id        TEXT,
  object_key        TEXT    NOT NULL,
  filename          TEXT    NOT NULL,
  content_type      TEXT,
  size              BIGINT,
  folder_path       TEXT,
  canvas_updated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, canvas_file_id)
);

CREATE INDEX IF NOT EXISTS idx_files_user_subject ON files(user_id, subject_id);
