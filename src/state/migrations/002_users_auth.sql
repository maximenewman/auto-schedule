-- Phase B: per-user Google tokens + signed-cookie sessions.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_refresh_token        TEXT,
  ADD COLUMN IF NOT EXISTS google_access_token         TEXT,
  ADD COLUMN IF NOT EXISTS google_access_token_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS google_scope                TEXT,
  ADD COLUMN IF NOT EXISTS google_token_obtained_at    TIMESTAMPTZ;

-- Sessions live server-side so logout actually revokes. The cookie carries
-- only the session id (a random 32-byte token), never any user data.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_expires
  ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions(expires_at);
