import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDisplayName,
  summarizeFieldChanges,
} from '../src/report/executive.mjs';

describe('report/executive extractDisplayName', () => {
  it('returns name when present', () => {
    assert.equal(extractDisplayName({ name: 'My App' }), 'My App');
    assert.equal(extractDisplayName('{"name":"Repo One"}'), 'Repo One');
  });

  it('falls back to title then id', () => {
    assert.equal(extractDisplayName({ title: 'A Title' }), 'A Title');
    assert.equal(extractDisplayName({ id: 'item-123' }), 'item-123');
  });

  it('prefers name over title over id', () => {
    assert.equal(
      extractDisplayName({ name: 'N', title: 'T', id: 'I' }),
      'N'
    );
    assert.equal(
      extractDisplayName({ title: 'T', id: 'I' }),
      'T'
    );
  });

  it('truncates long values with ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = extractDisplayName({ name: long });
    assert.ok(result.endsWith('...'));
    assert.ok(result.length <= 150 + 3);
  });

  it('returns null for invalid or empty input', () => {
    assert.equal(extractDisplayName(null), null);
    assert.equal(extractDisplayName(undefined), null);
    assert.equal(extractDisplayName(''), null);
    assert.equal(extractDisplayName('not json'), null);
    assert.equal(extractDisplayName({}), null);
    assert.equal(extractDisplayName({ foo: 'bar' }), null);
  });
});

describe('report/executive summarizeFieldChanges', () => {
  it('returns summary string for changed fields', () => {
    const fieldChanges = { status: { old: 'open', new: 'closed' }, severity: { old: 'low', new: 'high' } };
    const changedFields = ['status', 'severity'];
    const result = summarizeFieldChanges(fieldChanges, changedFields);
    assert.ok(result.includes('status:'));
    assert.ok(result.includes('open → closed'));
    assert.ok(result.includes('severity:'));
    assert.ok(result.includes('low → high'));
  });

  it('accepts JSON strings for fieldChanges and changedFields', () => {
    const result = summarizeFieldChanges(
      '{"status":{"old":"new","new":"open"}}',
      '["status"]'
    );
    assert.ok(result.includes('status:'));
    assert.ok(result.includes('new → open'));
  });

  it('truncates long values to 50 chars', () => {
    const long = 'a'.repeat(60);
    const result = summarizeFieldChanges(
      { f: { old: long, new: 'short' } },
      ['f']
    );
    assert.ok(result.includes('short'));
    assert.ok(result.includes('a'.repeat(50)));
  });

  it('returns null for invalid or empty input', () => {
    assert.equal(summarizeFieldChanges(null, []), null);
    assert.equal(summarizeFieldChanges({}, []), null);
    assert.equal(summarizeFieldChanges({ status: {} }, ['status']), null);
  });
});
