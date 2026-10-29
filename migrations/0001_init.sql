CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  params TEXT NOT NULL,            -- JSON of sam_search_opportunities args
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  last_total INTEGER,
  known_ids TEXT NOT NULL DEFAULT '[]',  -- notice ids already seen by a run
  new_ids TEXT NOT NULL DEFAULT '[]'     -- found since the user last cleared them
);
CREATE TABLE IF NOT EXISTS pipeline (
  notice_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agency TEXT,
  due TEXT,
  ui_link TEXT,
  naics TEXT,
  status TEXT NOT NULL DEFAULT 'watching',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vet_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  uei TEXT,
  checked_at TEXT NOT NULL,
  exclusions TEXT NOT NULL,        -- clear | hit | error
  ofac TEXT NOT NULL,              -- clear | hit | error
  detail TEXT
);
CREATE INDEX IF NOT EXISTS vet_name ON vet_history(name COLLATE NOCASE, checked_at DESC);
