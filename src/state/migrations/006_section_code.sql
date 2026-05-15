-- SFU section code (e.g. "D100" / "D101") parsed from the CourSys UID or
-- from the PDF schedule. Lets the post-sync enrichment pass query
-- api.sfucourses.com for the right section's instructor list.

ALTER TABLE calendar_items
  ADD COLUMN IF NOT EXISTS section_code TEXT;

CREATE INDEX IF NOT EXISTS idx_calendar_items_section
  ON calendar_items(user_id, subject_id, section_code);
