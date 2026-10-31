CREATE TABLE IF NOT EXISTS grant_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  params TEXT NOT NULL,                    -- JSON of the /api/grants/search body
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  last_total INTEGER,
  known_ids TEXT NOT NULL DEFAULT '[]',
  new_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS recompete_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  naics TEXT,
  agency TEXT,
  min_value INTEGER NOT NULL DEFAULT 100000,
  created_at TEXT NOT NULL,
  last_scan_at TEXT,
  last_count INTEGER
);
CREATE TABLE IF NOT EXISTS recompetes (
  watch_id INTEGER NOT NULL,
  award_id TEXT NOT NULL,
  internal_id TEXT,
  incumbent TEXT,
  amount REAL,
  agency TEXT,
  sub_agency TEXT,
  naics TEXT,
  description TEXT,
  end_date TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,        -- 0 = new since the user last looked
  digested INTEGER NOT NULL DEFAULT 0,    -- 1 once included in a morning digest
  PRIMARY KEY (watch_id, award_id)
);
CREATE INDEX IF NOT EXISTS recompetes_end ON recompetes(end_date);
