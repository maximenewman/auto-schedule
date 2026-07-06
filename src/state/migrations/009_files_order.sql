-- Preserve the ordering files have in Canvas (module position, then item
-- position within the module) so the dashboard lists "Week 1, Week 2, ..."
-- exactly like the course page does.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;
