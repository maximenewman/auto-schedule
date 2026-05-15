-- Phase C: subjects move from data/subjects.json into the DB, scoped per user.

CREATE TABLE IF NOT EXISTS subjects (
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  code               TEXT,
  name               TEXT NOT NULL,
  professor          TEXT NOT NULL DEFAULT '',
  room               TEXT,
  term               TEXT,
  color              TEXT,
  destination_folder TEXT NOT NULL,
  sources            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_subjects_user ON subjects(user_id);
