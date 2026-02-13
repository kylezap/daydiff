import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.mjs';
import { insertSnapshot } from '../src/db/queries.mjs';
import { getDb } from '../src/db/index.mjs';

describe('Deterministic hashing', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('produces the same hash regardless of key insertion order', () => {
    // Two objects with identical content but different key insertion order
    const rowA = { key: '1', data: { zebra: 1, alpha: 2, middle: 3 } };
    const rowB = { key: '2', data: { alpha: 2, middle: 3, zebra: 1 } };

    insertSnapshot(dataset.id, '2025-01-01', [rowA, rowB]);

    const db = getDb();
    const rows = db.prepare(
      'SELECT row_key, row_hash FROM snapshot_rows ORDER BY row_key'
    ).all();

    assert.equal(rows.length, 2);
    assert.equal(rows[0].row_hash, rows[1].row_hash,
      'Same data with different key order should produce the same hash');
  });

  it('produces different hashes for different data', () => {
    const rowA = { key: '1', data: { name: 'foo', value: 10 } };
    const rowB = { key: '2', data: { name: 'foo', value: 20 } };

    insertSnapshot(dataset.id, '2025-01-01', [rowA, rowB]);

    const db = getDb();
    const rows = db.prepare(
      'SELECT row_key, row_hash FROM snapshot_rows ORDER BY row_key'
    ).all();

    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].row_hash, rows[1].row_hash,
      'Different data should produce different hashes');
  });

  it('handles nested objects deterministically', () => {
    const rowA = { key: '1', data: { outer: { z: 1, a: 2 }, list: [3, 2, 1] } };
    const rowB = { key: '2', data: { outer: { a: 2, z: 1 }, list: [3, 2, 1] } };

    insertSnapshot(dataset.id, '2025-01-01', [rowA, rowB]);

    const db = getDb();
    const rows = db.prepare(
      'SELECT row_key, row_hash FROM snapshot_rows ORDER BY row_key'
    ).all();

    assert.equal(rows[0].row_hash, rows[1].row_hash,
      'Nested objects with same content but different key order should hash identically');
  });

  it('distinguishes different array orders', () => {
    const rowA = { key: '1', data: { list: [1, 2, 3] } };
    const rowB = { key: '2', data: { list: [3, 2, 1] } };

    insertSnapshot(dataset.id, '2025-01-01', [rowA, rowB]);

    const db = getDb();
    const rows = db.prepare(
      'SELECT row_key, row_hash FROM snapshot_rows ORDER BY row_key'
    ).all();

    assert.notEqual(rows[0].row_hash, rows[1].row_hash,
      'Different array orderings should produce different hashes');
  });

  it('handles null and primitive values', () => {
    const rowA = { key: '1', data: { a: null, b: 0, c: '', d: false } };
    const rowB = { key: '2', data: { a: null, b: 0, c: '', d: false } };

    insertSnapshot(dataset.id, '2025-01-01', [rowA, rowB]);

    const db = getDb();
    const rows = db.prepare(
      'SELECT row_key, row_hash FROM snapshot_rows ORDER BY row_key'
    ).all();

    assert.equal(rows[0].row_hash, rows[1].row_hash,
      'Identical primitive/null values should hash the same');
  });

  it('produces a 64-character hex hash (SHA-256)', () => {
    insertSnapshot(dataset.id, '2025-01-01', [
      { key: '1', data: { test: true } },
    ]);

    const db = getDb();
    const row = db.prepare('SELECT row_hash FROM snapshot_rows').get();

    assert.match(row.row_hash, /^[0-9a-f]{64}$/,
      'Hash should be a 64-character hex string');
  });
});
