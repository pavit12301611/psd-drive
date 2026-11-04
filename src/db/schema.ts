import { exec, get, pluck } from './index.ts'

/**
 * Schema migrations. `PRAGMA user_version` tracks the applied version, so
 * upgrades are a simple, atomic, dependency-free loop.
 */

const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: /* sql */ `
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_url    TEXT,
      role          TEXT NOT NULL DEFAULT 'owner',
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip         TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX idx_sessions_user ON sessions(user_id);

    -- Connected storage accounts (google drive, s3-compatible bucket, local disk)
    CREATE TABLE accounts (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider            TEXT NOT NULL,
      label               TEXT NOT NULL,
      email               TEXT,
      avatar_url          TEXT,
      provider_account_id TEXT NOT NULL,
      access_token        TEXT,
      refresh_token       TEXT,
      token_expires_at    INTEGER,
      scopes              TEXT,
      config              TEXT,
      total_bytes         INTEGER,
      used_bytes          INTEGER NOT NULL DEFAULT 0,
      available_bytes     INTEGER,
      quota_synced_at     INTEGER,
      priority            INTEGER NOT NULL DEFAULT 0,
      enabled             INTEGER NOT NULL DEFAULT 1,
      is_demo             INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'connected',
      last_error          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE (user_id, provider, provider_account_id)
    );
    CREATE INDEX idx_accounts_user ON accounts(user_id, enabled);

    CREATE TABLE folders (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT 'indigo',
      icon       TEXT NOT NULL DEFAULT 'folder',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX idx_folders_user_parent ON folders(user_id, deleted_at, parent_id, name);
    CREATE INDEX idx_folders_parent ON folders(parent_id);

    CREATE TABLE files (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      folder_id        TEXT REFERENCES folders(id) ON DELETE SET NULL,
      provider_file_id TEXT NOT NULL,
      name             TEXT NOT NULL,
      mime_type        TEXT NOT NULL,
      size_bytes       INTEGER NOT NULL DEFAULT 0,
      checksum         TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      starred          INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      deleted_at       INTEGER
    );
    -- One composite index serves every browse query (folder listing, trash,
    -- starred, recents) so listing stays a pure index scan as the library grows.
    CREATE INDEX idx_files_browse ON files(user_id, status, folder_id, updated_at DESC);
    CREATE INDEX idx_files_name ON files(user_id, name);
    CREATE INDEX idx_files_account ON files(account_id);
    CREATE INDEX idx_files_folder ON files(folder_id);
    CREATE INDEX idx_files_starred ON files(user_id, starred, updated_at DESC);

    CREATE TABLE shares (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id        TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      token          TEXT NOT NULL UNIQUE,
      expires_at     INTEGER,
      download_count INTEGER NOT NULL DEFAULT 0,
      view_count     INTEGER NOT NULL DEFAULT 0,
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_shares_user ON shares(user_id, created_at DESC);
    CREATE INDEX idx_shares_file ON shares(file_id);

    CREATE TABLE api_keys (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      prefix       TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      scopes       TEXT NOT NULL DEFAULT 'upload,read',
      last_used_at INTEGER,
      revoked_at   INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_api_keys_user ON api_keys(user_id, revoked_at);

    CREATE TABLE activity (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      entity_name TEXT,
      meta        TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_activity_user ON activity(user_id, created_at DESC);

    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Instant filename search: FTS5 external-content table kept in sync by triggers.
    CREATE VIRTUAL TABLE files_fts USING fts5(
      name,
      content = 'files',
      content_rowid = 'rowid',
      tokenize = "unicode61 remove_diacritics 2"
    );
    CREATE TRIGGER files_fts_ai AFTER INSERT ON files BEGIN
      INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
    END;
    CREATE TRIGGER files_fts_ad AFTER DELETE ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
    END;
    CREATE TRIGGER files_fts_au AFTER UPDATE OF name ON files BEGIN
      INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
      INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
    END;
  `,
  },
  {
    // "Continue with Google": a user can be identified by their Google subject
    // instead of (or as well as) a password.
    version: 2,
    sql: /* sql */ `
    ALTER TABLE users ADD COLUMN google_id TEXT;
    CREATE UNIQUE INDEX idx_users_google ON users(google_id) WHERE google_id IS NOT NULL;
  `,
  },
]

export function migrate(): void {
  const current = Number(pluck<number>('PRAGMA user_version') ?? 0)
  for (const m of migrations) {
    if (m.version <= current) continue
    exec('BEGIN IMMEDIATE')
    try {
      exec(m.sql)
      exec(`PRAGMA user_version = ${m.version}`)
      exec('COMMIT')
    } catch (err) {
      exec('ROLLBACK')
      throw err
    }
  }
}

export function dbInfo() {
  return {
    version: get<{ v: string }>('select sqlite_version() as v')?.v ?? 'unknown',
    pageCount: Number(get<{ c: number }>('PRAGMA page_count')?.c ?? 0),
    users: Number(get<{ c: number }>('select count(*) as c from users')?.c ?? 0),
  }
}
