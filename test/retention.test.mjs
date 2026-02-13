import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from './helpers.mjs';
import {
  insertSnapshot,
  insertDiff,
  pruneSnapshots,
  getPopulationTrend,
} from '../src/db/queries.mjs';
import { getDb, ensureDataset } from '../src/db/index.mjs';

describe('Snapshot retention (pruneSnapshots)', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('deletes snapshots and rows older than retention period', () => {
    // Create snapshots: one very old, one recent
    const today = new Date().toISOString().slice(0, 10);
    const oldDate = '2020-01-01'; // definitely older than any retention

    insertSnapshot(dataset.id, oldDate, [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
    ]);

    insertSnapshot(dataset.id, today, [
      { key: 'A', data: { val: 3 } },
    ]);

    const result = pruneSnapshots(30);

    assert.equal(result.deletedSnapshots, 1, 'Should delete the old snapshot');
    assert.equal(result.deletedRows, 2, 'Should delete 2 old rows');

    // Recent snapshot should still exist
    const remaining = getDb().prepare('SELECT * FROM snapshots').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fetched_date, today);

    // Recent snapshot rows should still exist
    const remainingRows = getDb().prepare('SELECT * FROM snapshot_rows').all();
    assert.equal(remainingRows.length, 1);
  });

  it('keeps snapshots within the retention window', () => {
    const today = new Date().toISOString().slice(0, 10);

    insertSnapshot(dataset.id, today, [
      { key: 'A', data: { val: 1 } },
    ]);

    const result = pruneSnapshots(30);

    assert.equal(result.deletedSnapshots, 0);
    assert.equal(result.deletedRows, 0);
  });

  it('keeps all diffs and diff_items regardless of age', () => {
    const oldDate = '2020-01-01';
    const oldDate2 = '2020-01-02';

    insertSnapshot(dataset.id, oldDate, [{ key: 'A', data: { val: 1 } }]);
    insertSnapshot(dataset.id, oldDate2, [{ key: 'A', data: { val: 2 } }]);

    // Create a diff for the old dates
    const summary = { added: 0, removed: 0, modified: 1, unchanged: 0 };
    const items = [{
      rowKey: 'A',
      changeType: 'modified',
      rowData: { val: 2 },
      fieldChanges: { val: { old: 1, new: 2 } },
      changedFields: ['val'],
    }];
    const diffId = insertDiff(dataset.id, oldDate, oldDate2, summary, items);

    // Prune snapshots
    pruneSnapshots(30);

    // Snapshots should be gone
    const snaps = getDb().prepare('SELECT * FROM snapshots').all();
    assert.equal(snaps.length, 0);

    // But diffs and diff_items should remain
    const diffs = getDb().prepare('SELECT * FROM diffs').all();
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].id, diffId);

    const diffItems = getDb().prepare('SELECT * FROM diff_items WHERE diff_id = ?').all(diffId);
    assert.equal(diffItems.length, 1);
  });

  it('returns zero counts when nothing to prune', () => {
    const result = pruneSnapshots(30);

    assert.equal(result.deletedSnapshots, 0);
    assert.equal(result.deletedRows, 0);
  });

  it('handles mixed ages correctly', () => {
    const today = new Date().toISOString().slice(0, 10);

    // Create 3 snapshots at different ages
    insertSnapshot(dataset.id, '2020-01-01', [{ key: 'A', data: { v: 1 } }]);
    insertSnapshot(dataset.id, '2020-06-01', [{ key: 'B', data: { v: 2 } }]);
    insertSnapshot(dataset.id, today, [{ key: 'C', data: { v: 3 } }]);

    const result = pruneSnapshots(30);

    assert.equal(result.deletedSnapshots, 2, 'Should delete both old snapshots');
    assert.equal(result.deletedRows, 2, 'Should delete one row from each old snapshot');

    const remaining = getDb().prepare('SELECT * FROM snapshots').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fetched_date, today);
  });
});

describe('Population trend (getPopulationTrend)', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('returns daily row counts and metadata', () => {
    insertSnapshot(dataset.id, '2025-02-10', [
      { key: 'A', data: {} },
      { key: 'B', data: {} },
    ], { apiTotal: 5, fetchWarnings: 'partial' });

    insertSnapshot(dataset.id, '2025-02-11', [
      { key: 'A', data: {} },
      { key: 'B', data: {} },
      { key: 'C', data: {} },
    ], { apiTotal: 3, fetchWarnings: null });

    const trend = getPopulationTrend(30, dataset.id);

    assert.equal(trend.length, 2);

    // Most recent first
    assert.equal(trend[0].fetched_date, '2025-02-11');
    assert.equal(trend[0].row_count, 3);
    assert.equal(trend[0].api_total, 3);
    assert.equal(trend[0].fetch_warnings, null);

    assert.equal(trend[1].fetched_date, '2025-02-10');
    assert.equal(trend[1].row_count, 2);
    assert.equal(trend[1].api_total, 5);
    assert.equal(trend[1].fetch_warnings, 'partial');
  });

  it('filters by category', () => {
    const platformDs = ensureDataset('platform-test', '/apps', 'id', 'platform');

    insertSnapshot(dataset.id, '2025-02-10', [{ key: 'A', data: {} }]);
    insertSnapshot(platformDs.id, '2025-02-10', [{ key: 'B', data: {} }]);

    const vulnTrend = getPopulationTrend(30, null, 'vulnerability');
    assert.equal(vulnTrend.length, 1);
    assert.equal(vulnTrend[0].dataset_name, 'test-app');

    const platformTrend = getPopulationTrend(30, null, 'platform');
    assert.equal(platformTrend.length, 1);
    assert.equal(platformTrend[0].dataset_name, 'platform-test');
  });
});
