-- schema.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('PERSONAL','DEPT','ORG')),
  share_mode TEXT NOT NULL CHECK(share_mode IN ('ALL','ATTENDEES_ONLY')),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'REQUIRED',
  response_status TEXT NOT NULL DEFAULT 'PENDING',
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_acl (
  acl_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  principal_type TEXT NOT NULL CHECK(principal_type IN ('USER','DEPT','ORG')),
  principal_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('VIEW','EDIT')),
  effect TEXT NOT NULL CHECK(effect IN ('ALLOW')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
