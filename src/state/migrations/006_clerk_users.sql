-- Clerk becomes the identity provider. Internal integer user ids stay; the
-- Clerk user id is a lookup key stamped on first sign-in. Legacy rows are
-- claimed by email match (see Store.findOrCreateUserByClerkId).
-- The sessions table is left in place until the cleanup migration so the
-- previous app version still runs against this schema.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;
