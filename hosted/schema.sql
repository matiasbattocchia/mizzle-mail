-- Hosted Mizzle — D1 schema.  Apply with:  npm run db:init   (add :local for dev)
--
-- Two tables, per the chosen design (sessions table, not a cookie-only JWT):
--   users    — one row per Google account that has signed in.
--   sessions — opaque server-side sessions; the cookie holds only a random id.

CREATE TABLE IF NOT EXISTS users (
  sub           TEXT PRIMARY KEY,   -- Google account id (stable 'sub' claim)
  email         TEXT NOT NULL,      -- the Gmail address (also the feed identity)
  access_token  TEXT,               -- current OAuth access token
  refresh_token TEXT,               -- long-lived refresh token (offline access)
  token_expiry  INTEGER,            -- access-token expiry, epoch ms
  cutoff        TEXT,               -- onboarding cutoff (ISO); mail before it is ignored, forever
  created_at    INTEGER NOT NULL    -- first sign-in, epoch ms
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,      -- random session id (the cookie value)
  sub        TEXT NOT NULL,         -- -> users.sub
  expires_at INTEGER NOT NULL,      -- epoch ms; expired rows are ignored and pruned
  created_at INTEGER NOT NULL,
  FOREIGN KEY (sub) REFERENCES users(sub)
);

CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub);

-- thread_cache — rendered feed item per thread, so a feed load only re-fetches the
-- threads that actually changed (validated by latest_uid, the thread's newest inbox
-- message id) instead of re-fetching all ~100+ candidates every time. Decay is NOT
-- cached (recomputed each load); flag-only changes are invalidated on mutation.
CREATE TABLE IF NOT EXISTS thread_cache (
  sub        TEXT NOT NULL,           -- -> users.sub
  thread_id  TEXT NOT NULL,           -- Gmail thread id
  latest_uid TEXT NOT NULL,           -- newest inbox message id when cached (cache key check)
  item_json  TEXT NOT NULL,           -- the rendered feed item (sans decay), JSON
  updated_at INTEGER NOT NULL,        -- epoch ms
  PRIMARY KEY (sub, thread_id)
);
