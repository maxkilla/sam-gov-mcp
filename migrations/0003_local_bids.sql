-- State and local solicitations found on Bonfire and OpenGov portals, with when each was first seen.
CREATE TABLE IF NOT EXISTS local_bids (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  src TEXT NOT NULL,
  gov TEXT NOT NULL,
  title TEXT NOT NULL,
  number TEXT,
  text TEXT,
  type TEXT,
  due TEXT,
  released TEXT,
  link TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_bids_state ON local_bids(state, due);
CREATE TABLE IF NOT EXISTS local_states (
  state TEXT PRIMARY KEY,
  watched INTEGER NOT NULL DEFAULT 0,
  baselined INTEGER NOT NULL DEFAULT 0,   -- 1 once one full scan finished, so the first scan is not announced as "new"
  last_viewed TEXT,
  last_scan_at TEXT,
  last_digest_at TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,      -- next portal for the background refresh
  portals_total INTEGER
);
