-- Signing in on the site: clients with Google or with a code sent to their phone by SMS (to see
-- the sessions left on their card, their bookings, and to book from the card at once), and
-- managers with Google as well as Face ID. Only new tables: until this is applied, the site
-- works as before, without signing in.

-- A client who signs in. With Google (google_sub: Google's own id for them, which never changes)
-- and/or a phone number they proved is theirs with a code sent to it.
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub    TEXT UNIQUE,
  google_email  TEXT,                    -- as Google gives it (Google checked it's theirs)
  google_key    TEXT,                    -- the same address, written one way (for matching)
  name          TEXT,                    -- as Google gives it
  phone         TEXT,                    -- digits only (0501234567), once proven with a code
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
-- Signing in with the phone alone: one account per number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_phone ON accounts (phone) WHERE google_sub IS NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_google_key ON accounts (google_key);

-- Who is signed in on the site. Only a hash of each session's cookie is kept.
CREATE TABLE IF NOT EXISTS account_sessions (
  id_hash    TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions (account_id);

-- The Gmail address David connected to a client's card in the admin panel: whoever signs in
-- with that Google account sees the card. Only he connects one (an address typed into a
-- booking proves nothing).
CREATE TABLE IF NOT EXISTS client_google (
  client_id INTEGER PRIMARY KEY REFERENCES clients (id) ON DELETE CASCADE,
  email     TEXT NOT NULL,               -- as he typed it
  email_key TEXT NOT NULL UNIQUE         -- written one way (for matching)
);

-- A manager's Google account, connected by them in the admin panel right after signing in.
CREATE TABLE IF NOT EXISTS admin_google (
  admin_id   INTEGER PRIMARY KEY REFERENCES admins (id) ON DELETE CASCADE,
  sub        TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
