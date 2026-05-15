-- Per-subject section code (e.g. "D100"). Filled by the iCal sync from
-- the CourSys UID and used by the sfucourses.com enrichment to pick the
-- exact section the student is enrolled in (different sections of the
-- same course can have different professors).

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS section TEXT;
