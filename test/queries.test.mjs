import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from './helpers.mjs';
import {
  insertSnapshot,
  getLatestSnapshot,
  getPreviousSnapshot,
  getAddedRows,
  getRemovedRows,
  getModifiedRows,
  getUnchangedCount,
  insertDiff,
  getDiff,
  getDiffItems,
} from '../src/db/queries.mjs';
import { getDb } from '../src/db/index.mjs';

describe('Snapshot queries', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('insertSnapshot stores rows with hashes and metadata', () => {
    const rows = [
      { key: 'r1', data: { name: 'alpha' } },
      { key: 'r2', data: { name: 'beta' } },
    ];

    const result = insertSnapshot(dataset.id, '2025-01-15', rows, {
      apiTotal: 100,
      fetchWarnings: 'truncated',
    });

    assert.equal(result.rowCount, 2);
    assert.ok(result.snapshotId > 0);

    // Verify snapshot metadata
    const snap = getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(result.snapshotId);
    assert.equal(snap.row_count, 2);
    assert.equal(snap.api_total, 100);
    assert.equal(snap.fetch_warnings, 'truncated');

    // Verify all rows have hashes
    const stored = getDb().prepare(
      'SELECT row_hash FROM snapshot_rows WHERE snapshot_id = ?'
    ).all(result.snapshotId);
    assert.equal(stored.length, 2);
    for (const row of stored) {
      assert.ok(row.row_hash, 'Every row should have a hash');
      assert.match(row.row_hash, /^[0-9a-f]{64}$/);
    }
  });

  it('insertSnapshot overwrites when re-running for same dataset+date', () => {
    insertSnapshot(dataset.id, '2025-01-15', [
      { key: 'r1', data: { v: 1 } },
    ]);

    // Re-insert with different data
    const result = insertSnapshot(dataset.id, '2025-01-15', [
      { key: 'r1', data: { v: 2 } },
      { key: 'r2', data: { v: 3 } },
    ]);

    assert.equal(result.rowCount, 2);

    // Should have exactly one snapshot for this date
    const snaps = getDb().prepare(
      'SELECT * FROM snapshots WHERE dataset_id = ? AND fetched_date = ?'
    ).all(dataset.id, '2025-01-15');
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].row_count, 2);
  });

  it('getLatestSnapshot returns the most recent snapshot on or before a date', () => {
    insertSnapshot(dataset.id, '2025-01-10', [{ key: '1', data: {} }]);
    insertSnapshot(dataset.id, '2025-01-15', [{ key: '1', data: {} }]);
    insertSnapshot(dataset.id, '2025-01-20', [{ key: '1', data: {} }]);

    const snap = getLatestSnapshot(dataset.id, '2025-01-17');
    assert.equal(snap.fetched_date, '2025-01-15');
  });

  it('getPreviousSnapshot returns the snapshot before a given date', () => {
    insertSnapshot(dataset.id, '2025-01-10', [{ key: '1', data: {} }]);
    insertSnapshot(dataset.id, '2025-01-15', [{ key: '1', data: {} }]);

    const snap = getPreviousSnapshot(dataset.id, '2025-01-15');
    assert.equal(snap.fetched_date, '2025-01-10');
  });

  it('getPreviousSnapshot returns undefined when no previous snapshot exists', () => {
    insertSnapshot(dataset.id, '2025-01-10', [{ key: '1', data: {} }]);

    const snap = getPreviousSnapshot(dataset.id, '2025-01-10');
    assert.equal(snap, undefined);
  });
});

describe('SQL-based diff queries', () => {
  let dataset;
  let oldSnapId;
  let newSnapId;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;

    // Old snapshot: rows A, B, C
    const oldResult = insertSnapshot(dataset.id, '2025-01-14', [
      { key: 'A', data: { name: 'alpha', value: 1 } },
      { key: 'B', data: { name: 'beta', value: 2 } },
      { key: 'C', data: { name: 'gamma', value: 3 } },
    ]);
    oldSnapId = oldResult.snapshotId;

    // New snapshot: rows A (unchanged), B (modified), D (added), C removed
    const newResult = insertSnapshot(dataset.id, '2025-01-15', [
      { key: 'A', data: { name: 'alpha', value: 1 } },
      { key: 'B', data: { name: 'beta-updated', value: 2 } },
      { key: 'D', data: { name: 'delta', value: 4 } },
    ]);
    newSnapId = newResult.snapshotId;
  });

  it('getAddedRows finds rows only in the new snapshot', () => {
    const added = getAddedRows(newSnapId, oldSnapId);
    assert.equal(added.length, 1);
    assert.equal(added[0].row_key, 'D');

    const data = JSON.parse(added[0].row_data);
    assert.equal(data.name, 'delta');
  });

  it('getRemovedRows finds rows only in the old snapshot', () => {
    const removed = getRemovedRows(oldSnapId, newSnapId);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].row_key, 'C');

    const data = JSON.parse(removed[0].row_data);
    assert.equal(data.name, 'gamma');
  });

  it('getModifiedRows finds rows with same key but different hash', () => {
    const modified = getModifiedRows(oldSnapId, newSnapId);
    assert.equal(modified.length, 1);
    assert.equal(modified[0].row_key, 'B');

    const oldData = JSON.parse(modified[0].old_data);
    const newData = JSON.parse(modified[0].new_data);
    assert.equal(oldData.name, 'beta');
    assert.equal(newData.name, 'beta-updated');
  });

  it('getUnchangedCount counts rows with identical hashes', () => {
    const count = getUnchangedCount(oldSnapId, newSnapId);
    assert.equal(count, 1); // Only row A is unchanged
  });

  it('handles empty snapshots correctly', () => {
    const emptyResult = insertSnapshot(dataset.id, '2025-01-16', []);
    const emptySnapId = emptyResult.snapshotId;

    // Everything in new is "added" compared to empty
    const added = getAddedRows(newSnapId, emptySnapId);
    assert.equal(added.length, 3);

    // Nothing removed from empty
    const removed = getRemovedRows(emptySnapId, newSnapId);
    assert.equal(removed.length, 0);

    // Nothing modified
    const modified = getModifiedRows(emptySnapId, newSnapId);
    assert.equal(modified.length, 0);

    // Nothing unchanged
    const unchanged = getUnchangedCount(emptySnapId, newSnapId);
    assert.equal(unchanged, 0);
  });
});

describe('insertDiff', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('stores summary and items correctly', () => {
    const summary = { added: 1, removed: 1, modified: 1, unchanged: 5 };
    const items = [
      { rowKey: 'new-1', changeType: 'added', rowData: { id: 1 }, fieldChanges: null, changedFields: null },
      { rowKey: 'old-1', changeType: 'removed', rowData: { id: 2 }, fieldChanges: null, changedFields: null },
      {
        rowKey: 'mod-1',
        changeType: 'modified',
        rowData: { id: 3, name: 'new' },
        fieldChanges: { name: { old: 'old', new: 'new' } },
        changedFields: ['name'],
      },
    ];

    const diffId = insertDiff(dataset.id, '2025-01-14', '2025-01-15', summary, items);
    assert.ok(diffId > 0);

    const diff = getDiff(diffId);
    assert.equal(diff.added_count, 1);
    assert.equal(diff.removed_count, 1);
    assert.equal(diff.modified_count, 1);
    assert.equal(diff.unchanged_count, 5);

    const diffItems = getDiffItems(diffId);
    assert.equal(diffItems.length, 3);
  });

  it('accepts pre-serialized JSON strings for rowData', () => {
    const summary = { added: 1, removed: 0, modified: 0, unchanged: 0 };
    const items = [
      {
        rowKey: 'raw-1',
        changeType: 'added',
        rowData: '{"id":1,"name":"pre-serialized"}',  // raw JSON string
        fieldChanges: null,
        changedFields: null,
      },
    ];

    const diffId = insertDiff(dataset.id, '2025-01-14', '2025-01-15', summary, items);

    const diffItems = getDiffItems(diffId);
    assert.equal(diffItems.length, 1);

    const stored = JSON.parse(diffItems[0].row_data);
    assert.equal(stored.name, 'pre-serialized');
  });

  it('overwrites when re-running for the same date pair', () => {
    const summary1 = { added: 5, removed: 0, modified: 0, unchanged: 0 };
    insertDiff(dataset.id, '2025-01-14', '2025-01-15', summary1, []);

    const summary2 = { added: 10, removed: 0, modified: 0, unchanged: 0 };
    const diffId2 = insertDiff(dataset.id, '2025-01-14', '2025-01-15', summary2, []);

    const diff = getDiff(diffId2);
    assert.equal(diff.added_count, 10, 'Should reflect the latest run');

    // Should only have one diff record for this date pair
    const allDiffs = getDb().prepare(
      'SELECT * FROM diffs WHERE dataset_id = ? AND from_date = ? AND to_date = ?'
    ).all(dataset.id, '2025-01-14', '2025-01-15');
    assert.equal(allDiffs.length, 1);
  });
});
