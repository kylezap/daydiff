import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/default.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let _db = null;

/**
 * Get (or create) the singleton database connection.
 */
export function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  const dbPath = resolve(config.dataDir, 'daydiff.db');
  _db = new Database(dbPath);

  // Performance and safety pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  // Run schema migration
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  _db.exec(schema);

  return _db;
}

/**
 * Close the database connection.
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Ensure a dataset record exists in the DB. Returns the dataset row.
 */
export function ensureDataset(name, endpoint, rowKey) {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO datasets (name, endpoint, row_key)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET endpoint = excluded.endpoint, row_key = excluded.row_key
  `);
  upsert.run(name, endpoint, rowKey);

  return db.prepare('SELECT * FROM datasets WHERE name = ?').get(name);
}
