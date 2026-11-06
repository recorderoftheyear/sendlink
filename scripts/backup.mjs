// Online SQLite backup, safe while the server is running (uses SQLite's backup API, WAL-aware).
// Usage: npm run backup [-- <destination>]    (default: ./backups/sendlink-<timestamp>.db)
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const source = process.env.DB_PATH ?? './data/sendlink.db';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = process.argv[2] ?? `./backups/sendlink-${stamp}.db`;

mkdirSync(dirname(destination), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(destination);
db.close();
console.log(`Backed up ${source} -> ${destination}`);
