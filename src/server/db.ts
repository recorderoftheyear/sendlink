import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

// v1: initial MVP schema. `devices` rows are *clients* (one per credential-holding installation).
const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('desktop', 'mobile')),
  token_hash   TEXT NOT NULL UNIQUE,
  public_key   TEXT,               -- reserved for end-to-end encryption
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Temporary, single-use pairing tokens created by the device showing the QR code.
CREATE TABLE IF NOT EXISTS pairing_tokens (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,  -- long secret carried by the QR code
  code_hash   TEXT NOT NULL UNIQUE,  -- short code for manual entry
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Symmetric trust relationship between two devices (device_a < device_b).
CREATE TABLE IF NOT EXISTS pairings (
  id         TEXT PRIMARY KEY,
  device_a   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  device_b   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (device_a, device_b),
  CHECK (device_a < device_b)
);

-- Links delivered to a device (its inbox / history).
CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  target_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sender_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_by_target ON links (target_id, created_at DESC);
`;

/**
 * Ordered migrations; PRAGMA user_version = number of migrations applied.
 * Databases created before versioning have user_version 0 and the v1 schema,
 * which the idempotent baseline leaves untouched.
 */
export const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(BASELINE_SCHEMA),

  // v2: split identity into physical_device (the machine, human-named) and client
  // (an installation holding a credential: a browser profile or the installed PWA).
  // Every existing client gets its own physical device carrying its former name.
  (db) =>
    db.exec(`
      CREATE TABLE physical_devices (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('desktop', 'mobile')),
        created_at INTEGER NOT NULL
      );
      ALTER TABLE devices ADD COLUMN physical_device_id TEXT REFERENCES physical_devices(id) ON DELETE CASCADE;
      ALTER TABLE devices ADD COLUMN client_type TEXT NOT NULL DEFAULT 'browser' CHECK (client_type IN ('browser', 'pwa'));
      ALTER TABLE devices ADD COLUMN client_label TEXT;
      INSERT INTO physical_devices (id, name, kind, created_at)
        SELECT 'phy_' || substr(id, 5), name, kind, created_at FROM devices;
      UPDATE devices SET physical_device_id = 'phy_' || substr(id, 5);
      ALTER TABLE devices DROP COLUMN name;
      CREATE INDEX devices_by_physical ON devices (physical_device_id);
    `),

  // v3: sender-generated message_id, so one logical send stays one link whatever the
  // number of attempts or transports (retries, and later LAN + relay). Existing rows keep
  // NULL and are unaffected. Unique per sender: a sender can't pre-empt another's ids.
  (db) =>
    db.exec(`
      ALTER TABLE links ADD COLUMN message_id TEXT;
      CREATE UNIQUE INDEX links_by_message ON links (sender_id, message_id) WHERE message_id IS NOT NULL;
    `),
];

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
