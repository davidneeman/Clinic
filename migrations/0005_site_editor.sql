-- The site editor in the admin panel. The texts, treatments, prices and photos David changes
-- are kept as one JSON document in settings (key 'content'); uploaded photos are kept in
-- Workers KV (the MEDIA binding), not here.

-- Notices at the top of the site ("the clinic is closed until …", news, alerts).
CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'info',  -- 'info', 'news' or 'alert'
  text       TEXT NOT NULL,
  starts_at  TEXT,                          -- UTC, ISO 8601; NULL = from when it's saved
  ends_at    TEXT,                          -- UTC, ISO 8601; NULL = until it's turned off
  close_from TEXT,                          -- 'YYYY-MM-DD': no bookings on these days (or NULL)
  close_to   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,    -- 0 = paused
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A closed day that a notice made (deleted with it); NULL for the days closed by hand.
ALTER TABLE blocked_dates ADD COLUMN notice_id INTEGER;
