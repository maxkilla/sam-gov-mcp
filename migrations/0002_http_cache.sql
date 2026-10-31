-- Upstream response cache. Rows are ignored once expires_at (ms) passes and deleted by the nightly job.
CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  content_type TEXT NOT NULL,
  final_url TEXT,
  stored_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS http_cache_expires ON http_cache(expires_at);
