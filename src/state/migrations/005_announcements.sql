-- Atom-feed announcements (CourSys news entries) — one row per Atom entry.
-- The body (`content_html`) is kept verbatim so the dashboard can render it.
-- Subject attribution is best-effort via the iCal/PDF subject store; when
-- no match is found we keep the row anyway with subject_id = NULL so the
-- user can still see the announcement.

CREATE TABLE IF NOT EXISTS announcements (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id       TEXT NOT NULL,
  subject_id     TEXT,
  course_code    TEXT,
  title          TEXT NOT NULL DEFAULT '',
  content_html   TEXT NOT NULL DEFAULT '',
  link           TEXT,
  author         TEXT,
  published_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ,
  -- 'pending'  — not yet sent to the event extractor
  -- 'extracted'— extractor ran (regardless of whether it produced events)
  -- 'skipped'  — explicitly skipped (no course code, etc.)
  extract_status TEXT NOT NULL DEFAULT 'pending',
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_user_published
  ON announcements(user_id, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_announcements_subject
  ON announcements(user_id, subject_id);
