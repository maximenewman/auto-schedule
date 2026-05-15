-- Phase D: kill file downloads, move CourSys cookies into the DB.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS coursys_cookies            JSONB,
  ADD COLUMN IF NOT EXISTS coursys_cookies_updated_at TIMESTAMPTZ;

-- File downloads are gone — drop the tracking table and any rows it held.
DROP TABLE IF EXISTS downloaded_files;
