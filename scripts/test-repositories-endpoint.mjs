#!/usr/bin/env node
/**
 * Quick test for the /repositories REST endpoint.
 * Verifies that single-pass sequential pagination returns all records.
 * Uses the same limit and offset strategy as the real fetcher (no overlap).
 *
 * Usage: node scripts/test-repositories-endpoint.mjs
 */

import { apiRequest, closeClient } from '../src/api/client.mjs';

const ENDPOINT = '/repositories';
const LIMIT = 200;
const ROW_KEY = 'id';

function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (body?.data && Array.isArray(body.data)) return body.data;
  throw new Error('Response has no array (body or body.data)');
}

function extractPagination(body) {
  const pag = body?.pagination || body?.meta || null;
  if (!pag) return null;
  return {
    total: pag.total ?? pag.totalCount ?? pag.count ?? 0,
    pageSize: pag.limit ?? pag.pageSize ?? pag.per_page ?? 0,
  };
}

async function main() {
  console.log('[test] Repositories endpoint quick test\n');

  try {
    const body = await apiRequest(ENDPOINT, { params: { limit: LIMIT } });
    const rows = extractRows(body);
    const pag = extractPagination(body);

    if (!pag || pag.total === 0) {
      console.log('[test] No pagination metadata or total=0. Rows in first response:', rows.length);
      return;
    }

    const total = pag.total;
    const pageSize = Math.min(pag.pageSize || LIMIT, rows.length || LIMIT);

    const seen = new Map();
    for (const row of rows) {
      const key = row[ROW_KEY];
      if (key != null) seen.set(String(key), row);
    }

    let offset = pageSize;
    let pageNum = 1;
    while (offset < total) {
      const pageBody = await apiRequest(ENDPOINT, { params: { limit: LIMIT, offset } });
      const pageRows = extractRows(pageBody);
      for (const row of pageRows) {
        const key = row[ROW_KEY];
        if (key != null) seen.set(String(key), row);
      }
      pageNum++;
      if (pageRows.length < pageSize) break;
      offset += pageSize;
    }

    const uniqueCount = seen.size;
    const match = uniqueCount === total;
    const pct = total ? ((uniqueCount / total) * 100).toFixed(1) : '0';

    console.log('[test] API total:', total);
    console.log('[test] Unique records received:', uniqueCount);
    console.log('[test] Coverage:', pct + '%');
    console.log('[test] Pages requested:', pageNum);
    console.log('[test] Result:', match ? 'PASS — all records received' : 'FAIL — count mismatch');
    if (!match) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[test] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await closeClient();
  }
}

main();
