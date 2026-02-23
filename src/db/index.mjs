import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/default.mjs';
import datasetConfigs from '../../config/datasets.mjs';

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

  // ── Migrations ─────────────────────────────────────────────────

  // Migration 1: old_data/new_data → row_data/field_changes (slim storage)
  try {
    const diffCols = _db.pragma('table_info(diff_items)').map(c => c.name);
    if (diffCols.includes('old_data')) {
      console.log('[db] Migrating diff_items to slim storage format...');
      _db.exec('DROP TABLE IF EXISTS diff_items');
      _db.exec('DELETE FROM diffs');
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

  // Migration 2: add category column to datasets
  try {
    const dsCols = _db.pragma('table_info(datasets)').map(c => c.name);
    if (!dsCols.includes('category')) {
      console.log('[db] Adding category column to datasets...');
      _db.exec("ALTER TABLE datasets ADD COLUMN category TEXT NOT NULL DEFAULT 'platform'");
      console.log('[db] Category column added.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 3: add row_hash column to snapshot_rows + backfill existing rows
  try {
    const srCols = _db.pragma('table_info(snapshot_rows)').map(c => c.name);
    if (!srCols.includes('row_hash')) {
      console.log('[db] Adding row_hash column to snapshot_rows...');
      _db.exec('ALTER TABLE snapshot_rows ADD COLUMN row_hash TEXT');
      _db.exec(
        'CREATE INDEX IF NOT EXISTS idx_snapshot_rows_hash ON snapshot_rows(snapshot_id, row_key, row_hash)'
      );

      // Backfill hashes for existing rows
      const nullRows = _db.prepare(
        'SELECT id, row_data FROM snapshot_rows WHERE row_hash IS NULL'
      ).all();

      if (nullRows.length > 0) {
        console.log(`[db] Backfilling row_hash for ${nullRows.length} existing rows...`);
        const updateHash = _db.prepare('UPDATE snapshot_rows SET row_hash = ? WHERE id = ?');
        const backfill = _db.transaction(() => {
          for (const row of nullRows) {
            const hash = createHash('sha256').update(row.row_data).digest('hex');
            updateHash.run(hash, row.id);
          }
        });
        backfill();
        console.log('[db] Hash backfill complete.');
      }
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 4: add api_total and fetch_warnings columns to snapshots
  try {
    const snapCols = _db.pragma('table_info(snapshots)').map(c => c.name);
    if (!snapCols.includes('api_total')) {
      console.log('[db] Adding api_total and fetch_warnings columns to snapshots...');
      _db.exec('ALTER TABLE snapshots ADD COLUMN api_total INTEGER');
      _db.exec('ALTER TABLE snapshots ADD COLUMN fetch_warnings TEXT');
      console.log('[db] Snapshot metadata columns added.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 5: add assertion_results table
  try {
    const tables = _db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='assertion_results'"
    ).get();
    if (!tables) {
      console.log('[db] Creating assertion_results table...');
      _db.exec(`
        CREATE TABLE IF NOT EXISTS assertion_results (
          id INTEGER PRIMARY KEY,
          assertion_id TEXT NOT NULL,
          dataset_id INTEGER REFERENCES datasets(id),
          checked_date TEXT NOT NULL,
          passed INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          details TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      _db.exec(
        'CREATE INDEX IF NOT EXISTS idx_assertion_date ON assertion_results(checked_date, assertion_id)'
      );
      console.log('[db] assertion_results table created.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 6: sync dataset categories from config (fixes existing DBs where vuln datasets got category='platform')
  try {
    const update = _db.prepare('UPDATE datasets SET category = ? WHERE name = ?');
    for (const ds of datasetConfigs) {
      update.run(ds.category || 'platform', ds.name);
    }
  } catch {
    // Config may not be available in test env
  }

  // Migration 7: add executive_reports table
  try {
    const tables = _db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='executive_reports'"
    ).get();
    if (!tables) {
      console.log('[db] Creating executive_reports table...');
      _db.exec(`
        CREATE TABLE IF NOT EXISTS executive_reports (
          id INTEGER PRIMARY KEY,
          report_date TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          model_used TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      console.log('[db] executive_reports table created.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 8a: vuln_distribution_cache for pre-computed criticality/status counts
  try {
    const tables = _db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vuln_distribution_cache'"
    ).get();
    if (!tables) {
      console.log('[db] Creating vuln_distribution_cache table...');
      _db.exec(`
        CREATE TABLE IF NOT EXISTS vuln_distribution_cache (
          fetched_date TEXT NOT NULL,
          dataset_id INTEGER NOT NULL REFERENCES datasets(id),
          dimension TEXT NOT NULL CHECK(dimension IN ('criticality', 'status')),
          label TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (fetched_date, dataset_id, dimension, label)
        )
      `);
      _db.exec(
        'CREATE INDEX IF NOT EXISTS idx_vuln_dist_cache_date ON vuln_distribution_cache(fetched_date, dataset_id)'
      );
      console.log('[db] vuln_distribution_cache table created.');
    }
  } catch {
    // Table doesn't exist yet — schema.sql will create it
  }

  // Migration 8: rename platform datasets from lowercase to Title Case
  // Config changed applications→Applications, components→Components, repositories→Repositories.
  // Without this, ensureDataset would create NEW rows (name is unique), orphaning existing snapshots/diffs.
  try {
    const renames = [
      ['applications', 'Applications'],
      ['components', 'Components'],
      ['repositories', 'Repositories'],
    ];
    const updateName = _db.prepare('UPDATE datasets SET name = ? WHERE name = ?');
    for (const [oldName, newName] of renames) {
      const row = _db.prepare('SELECT id FROM datasets WHERE name = ?').get(oldName);
      const exists = _db.prepare('SELECT id FROM datasets WHERE name = ?').get(newName);
      if (row && !exists) {
        updateName.run(newName, oldName);
        console.log(`[db] Renamed dataset: ${oldName} → ${newName}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Sync: ensure all config datasets exist in DB (new datasets like Resources appear in UI before first fetch)
  try {
    for (const ds of datasetConfigs) {
      ensureDataset(ds.name, ds.endpoint, ds.rowKey, ds.category || 'platform');
    }
  } catch {
    // Config may not be available in test env
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
 * Inject a database instance (for testing with in-memory DBs).
 * @param {import('better-sqlite3').Database} db
 */
export function _setDbForTest(db) {
  _db = db;
}

/**
 * Ensure a dataset record exists in the DB. Returns the dataset row.
 */
export function ensureDataset(name, endpoint, rowKey, category = 'platform') {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO datasets (name, endpoint, row_key, category)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      endpoint = excluded.endpoint,
      row_key = excluded.row_key,
      category = excluded.category
  `);
  upsert.run(name, endpoint, rowKey, category);

  return db.prepare('SELECT * FROM datasets WHERE name = ?').get(name);
}
