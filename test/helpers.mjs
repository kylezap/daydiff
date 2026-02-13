import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { _setDbForTest, ensureDataset } from '../src/db/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'src', 'db', 'schema.sql');

/**
 * Create a fresh in-memory SQLite database with the full schema applied.
 * Injects it into the DB singleton so all query functions use it.
 *
 * Call this in a beforeEach or at the top of each test/describe block
 * to get a clean, isolated database.
 *
 * @returns {{ db: import('better-sqlite3').Database, dataset: object }}
 */
export function setupTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  // Inject into the singleton
  _setDbForTest(db);

  // Create a default test dataset
  const dataset = ensureDataset('test-app', '/test', 'id', 'vulnerability');

  return { db, dataset };
}

/**
 * Close the in-memory database and clear the singleton.
 */
export function teardownTestDb() {
  _setDbForTest(null);
}
