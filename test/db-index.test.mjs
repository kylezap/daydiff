import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.mjs';
import { ensureDataset, getDb, _setDbForTest } from '../src/db/index.mjs';

describe('db/index ensureDataset', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('returns a dataset row with id, name, endpoint, row_key, category', () => {
    const row = ensureDataset('my-dataset', '/api/items', 'id', 'vulnerability');
    assert.ok(row.id);
    assert.equal(row.name, 'my-dataset');
    assert.equal(row.endpoint, '/api/items');
    assert.equal(row.row_key, 'id');
    assert.equal(row.category, 'vulnerability');
  });

  it('is idempotent: same name returns same id on second call', () => {
    const first = ensureDataset('idempotent-ds', '/a', 'id', 'platform');
    const second = ensureDataset('idempotent-ds', '/a', 'id', 'platform');
    assert.equal(first.id, second.id, 'Same name should return same dataset id');
  });

  it('updates endpoint, row_key, and category when name exists', () => {
    ensureDataset('update-ds', '/old', 'pk', 'platform');
    const updated = ensureDataset('update-ds', '/new', 'rowId', 'vulnerability');

    assert.equal(updated.name, 'update-ds');
    assert.equal(updated.endpoint, '/new');
    assert.equal(updated.row_key, 'rowId');
    assert.equal(updated.category, 'vulnerability');

    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM datasets WHERE name = ?').get('update-ds').c;
    assert.equal(count, 1, 'Should still be a single row');
  });

  it('defaults category to platform when omitted', () => {
    const row = ensureDataset('default-cat', '/x', 'id');
    assert.equal(row.category, 'platform');
  });
});
