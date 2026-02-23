import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log, warn, error } from '../src/lib/logger.mjs';

describe('lib/logger', () => {
  let logCalls;
  let warnCalls;
  let errorCalls;
  let originalLog;
  let originalWarn;
  let originalError;

  beforeEach(() => {
    logCalls = [];
    warnCalls = [];
    errorCalls = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    console.log = (msg) => { logCalls.push(msg); };
    console.warn = (msg) => { warnCalls.push(msg); };
    console.error = (msg) => { errorCalls.push(msg); };
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it('log prefixes message with [HH:mm:ss]', () => {
    log('hello');
    assert.equal(logCalls.length, 1);
    assert.match(logCalls[0], /^\[\d{2}:\d{2}:\d{2}\] hello$/);
  });

  it('warn prefixes message with [HH:mm:ss]', () => {
    warn('warning');
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0], /^\[\d{2}:\d{2}:\d{2}\] warning$/);
  });

  it('error prefixes message with [HH:mm:ss]', () => {
    error('failed');
    assert.equal(errorCalls.length, 1);
    assert.match(errorCalls[0], /^\[\d{2}:\d{2}:\d{2}\] failed$/);
  });

  it('joins multiple arguments with space', () => {
    log('one', 'two', 'three');
    assert.equal(logCalls.length, 1);
    assert.match(logCalls[0], /one two three$/);
  });

  it('splits newlines and prefixes each line with same timestamp', () => {
    log('line1\nline2');
    assert.equal(logCalls.length, 1);
    const out = logCalls[0];
    assert.match(out, /^\[\d{2}:\d{2}:\d{2}\] line1$/m);
    assert.match(out, /\[\d{2}:\d{2}:\d{2}\] line2/);
    const lines = out.split('\n');
    const ts = lines[0].slice(0, 10); // "[HH:mm:ss]"
    assert.equal(lines[1].slice(0, 10), ts, 'Second line should have same timestamp prefix');
  });
});
