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

  // Run schema creation
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  _db.exec(schema);

  // Migration: old_data/new_data → row_data/field_changes
  // If diff_items still has old_data column, drop and recreate with new schema.
  // Diff data is regenerable from snapshots, so this is safe.
  try {
    const cols = _db.pragma('table_info(diff_items)').map(c => c.name);
    if (cols.includes('old_data')) {
      console.log('[db] Migrating diff_items to slim storage format...');
      _db.exec('DROP TABLE IF EXISTS diff_items');
      _db.exec('DELETE FROM diffs'); // Clear stale diff summaries too
      _db.exec(`
        CREATE TABLE IF NOT EXISTS diff_items (
          id INTEGER PRIMARY KEY,
          diff_id INTEGER NOT NULL REFERENCES diffs(id),
          row_key TEXT NOT NULL,
          change_type TEXT NOT NULL CHECK(change_type IN ('added','removed','modified')),
          row_data TEXT,
          field_changes TEXT,
          changed_fields TEXT,
          UNIQUE(diff_id, row_key)
        )
      `);
      _db.exec('CREATE INDEX IF NOT EXISTS idx_diff_items_type ON diff_items(diff_id, change_type)');
      console.log('[db] Migration complete. Re-run diffs to repopulate.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

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
