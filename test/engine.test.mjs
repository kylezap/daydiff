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

/**
 * Simulate the diff engine pipeline: given two snapshot IDs,
 * compute the diff and store it, exactly as engine.mjs does.
 *
 * This replicates the core logic of computeDiff + diffDataset
 * without importing private functions or coupling to config.
 */
function runDiffPipeline(datasetId, oldSnapId, newSnapId, fromDate, toDate) {
  const items = [];

  // Added rows
  const addedRows = getAddedRows(newSnapId, oldSnapId);
  for (const row of addedRows) {
    items.push({
      rowKey: row.row_key,
      changeType: 'added',
      rowData: row.row_data,
      fieldChanges: null,
      changedFields: null,
    });
  }

  // Removed rows
  const removedRows = getRemovedRows(oldSnapId, newSnapId);
  for (const row of removedRows) {
    items.push({
      rowKey: row.row_key,
      changeType: 'removed',
      rowData: row.row_data,
      fieldChanges: null,
      changedFields: null,
    });
  }

  // Modified rows — parse JSON to compute field-level changes
  const modifiedRows = getModifiedRows(oldSnapId, newSnapId);
  for (const row of modifiedRows) {
    const oldData = JSON.parse(row.old_data);
    const newData = JSON.parse(row.new_data);

    const changedFields = [];
    const fieldChanges = {};
    const allKeys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
    for (const key of allKeys) {
      if (JSON.stringify(oldData[key]) !== JSON.stringify(newData[key])) {
        changedFields.push(key);
        fieldChanges[key] = { old: oldData[key] ?? null, new: newData[key] ?? null };
      }
    }

    if (changedFields.length > 0) {
      items.push({
        rowKey: row.row_key,
        changeType: 'modified',
        rowData: row.new_data,
        fieldChanges,
        changedFields,
      });
    }
  }

  const unchanged = getUnchangedCount(oldSnapId, newSnapId);

  const summary = {
    added: addedRows.length,
    removed: removedRows.length,
    modified: items.filter(i => i.changeType === 'modified').length,
    unchanged,
  };

  const diffId = insertDiff(datasetId, fromDate, toDate, summary, items);
  return { diffId, summary, items };
}

describe('Diff engine integration', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  it('detects added, removed, modified, and unchanged rows', () => {
    // Day 1: rows A, B, C
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'A', data: { name: 'alpha', severity: 'HIGH' } },
      { key: 'B', data: { name: 'beta', severity: 'LOW' } },
      { key: 'C', data: { name: 'gamma', severity: 'MEDIUM' } },
    ]);

    // Day 2: A unchanged, B modified, C removed, D added
    const snap2 = insertSnapshot(dataset.id, '2025-02-02', [
      { key: 'A', data: { name: 'alpha', severity: 'HIGH' } },
      { key: 'B', data: { name: 'beta', severity: 'CRITICAL' } },
      { key: 'D', data: { name: 'delta', severity: 'INFO' } },
    ]);

    const { diffId, summary } = runDiffPipeline(
      dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02'
    );

    assert.equal(summary.added, 1, 'One row added (D)');
    assert.equal(summary.removed, 1, 'One row removed (C)');
    assert.equal(summary.modified, 1, 'One row modified (B)');
    assert.equal(summary.unchanged, 1, 'One row unchanged (A)');

    // Verify the stored diff
    const diff = getDiff(diffId);
    assert.equal(diff.added_count, 1);
    assert.equal(diff.removed_count, 1);
    assert.equal(diff.modified_count, 1);
    assert.equal(diff.unchanged_count, 1);

    // Verify diff items
    const items = getDiffItems(diffId);
    assert.equal(items.length, 3); // Only changed rows stored, not unchanged

    const added = items.find(i => i.change_type === 'added');
    assert.equal(added.row_key, 'D');

    const removed = items.find(i => i.change_type === 'removed');
    assert.equal(removed.row_key, 'C');

    const modified = items.find(i => i.change_type === 'modified');
    assert.equal(modified.row_key, 'B');
    const fieldChanges = JSON.parse(modified.field_changes);
    assert.deepEqual(fieldChanges.severity, { old: 'LOW', new: 'CRITICAL' });
  });

  it('handles first snapshot with no previous (returns no diff)', () => {
    insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'A', data: { name: 'alpha' } },
    ]);

    const prev = getPreviousSnapshot(dataset.id, '2025-02-01');
    assert.equal(prev, undefined, 'No previous snapshot should exist');
  });

  it('handles all rows being unchanged', () => {
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
    ]);

    const snap2 = insertSnapshot(dataset.id, '2025-02-02', [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
    ]);

    const { summary } = runDiffPipeline(
      dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02'
    );

    assert.equal(summary.added, 0);
    assert.equal(summary.removed, 0);
    assert.equal(summary.modified, 0);
    assert.equal(summary.unchanged, 2);
  });

  it('handles all rows being new (fresh dataset)', () => {
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', []);

    const snap2 = insertSnapshot(dataset.id, '2025-02-02', [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
      { key: 'C', data: { val: 3 } },
    ]);

    const { summary } = runDiffPipeline(
      dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02'
    );

    assert.equal(summary.added, 3);
    assert.equal(summary.removed, 0);
    assert.equal(summary.modified, 0);
    assert.equal(summary.unchanged, 0);
  });

  it('handles all rows being removed', () => {
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
    ]);

    const snap2 = insertSnapshot(dataset.id, '2025-02-02', []);

    const { summary } = runDiffPipeline(
      dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02'
    );

    assert.equal(summary.added, 0);
    assert.equal(summary.removed, 2);
    assert.equal(summary.modified, 0);
    assert.equal(summary.unchanged, 0);
  });

  it('correctly tracks field-level changes for modified rows', () => {
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'V1', data: { name: 'vuln-1', severity: 'LOW', status: 'detected' } },
    ]);

    const snap2 = insertSnapshot(dataset.id, '2025-02-02', [
      { key: 'V1', data: { name: 'vuln-1', severity: 'HIGH', status: 'in_progress' } },
    ]);

    const { diffId } = runDiffPipeline(
      dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02'
    );

    const items = getDiffItems(diffId);
    assert.equal(items.length, 1);
    assert.equal(items[0].change_type, 'modified');

    const changedFields = JSON.parse(items[0].changed_fields);
    assert.ok(changedFields.includes('severity'));
    assert.ok(changedFields.includes('status'));
    assert.ok(!changedFields.includes('name'), 'Unchanged field should not appear');

    const fieldChanges = JSON.parse(items[0].field_changes);
    assert.deepEqual(fieldChanges.severity, { old: 'LOW', new: 'HIGH' });
    assert.deepEqual(fieldChanges.status, { old: 'detected', new: 'in_progress' });
  });

  it('re-running diff for same date pair replaces old results', () => {
    const snap1 = insertSnapshot(dataset.id, '2025-02-01', [
      { key: 'A', data: { val: 1 } },
    ]);
    const snap2 = insertSnapshot(dataset.id, '2025-02-02', [
      { key: 'A', data: { val: 1 } },
      { key: 'B', data: { val: 2 } },
    ]);

    // First run
    runDiffPipeline(dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02');

    // Second run (same dates)
    const { diffId } = runDiffPipeline(dataset.id, snap1.snapshotId, snap2.snapshotId,
      '2025-02-01', '2025-02-02');

    const diff = getDiff(diffId);
    assert.equal(diff.added_count, 1);

    // Should only have one diff for these dates
    const allDiffs = require_getDiffCount(dataset.id, '2025-02-01', '2025-02-02');
    assert.equal(allDiffs, 1);
  });
});

// Helper to count diffs for a date pair (avoids importing getDb in test body)
import { getDb } from '../src/db/index.mjs';
function require_getDiffCount(datasetId, fromDate, toDate) {
  return getDb().prepare(
    'SELECT COUNT(*) as cnt FROM diffs WHERE dataset_id = ? AND from_date = ? AND to_date = ?'
  ).get(datasetId, fromDate, toDate).cnt;
}
