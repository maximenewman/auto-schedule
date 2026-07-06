-- Retire everything the v2 stack replaced:
--   sessions          -> Clerk owns sign-in
--   seen_emails       -> Gmail ingestion removed (Canvas is the source)
--   site_hashes       -> CourSys page scraping removed
--   users.google_sub  -> Google is no longer a login method
--   users.coursys_*   -> cookie scraping removed (token feeds need no auth)
--   subjects.sources          -> per-subject source config removed
--   subjects.destination_folder -> files live in object storage now

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS seen_emails;
DROP TABLE IF EXISTS site_hashes;

ALTER TABLE users
  DROP COLUMN IF EXISTS google_sub,
  DROP COLUMN IF EXISTS coursys_cookies,
  DROP COLUMN IF EXISTS coursys_cookies_updated_at;

ALTER TABLE subjects
  DROP COLUMN IF EXISTS sources,
  DROP COLUMN IF EXISTS destination_folder;
