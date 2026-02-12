import { apiRequest } from './client.mjs';
import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import { insertSnapshot } from '../db/queries.mjs';

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Default page size for paginated requests.
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Maximum pages to fetch as a safety valve (prevents runaway pagination).
 */
const MAX_PAGES = 200;

/**
 * Fetch all pages of a paginated DevGrid API endpoint.
 *
 * DevGrid paginated responses follow the shape:
 *   { data: [...], pagination: { page, limit, total, totalPages } }
 *
 * @param {string} endpoint
 * @param {object} params - Base query params
 * @param {object} headers - Extra headers
 * @param {Function|null} transform - Optional transform for extracting rows from body
 * @param {string} name - Dataset name (for logging)
 * @returns {Promise<object[]>} All rows across all pages
 */
async function fetchAllPages(endpoint, params, headers, transform, name) {
  let allRows = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const pageParams = {
      ...params,
      page,
      limit: params.limit || DEFAULT_PAGE_SIZE,
    };

    const body = await apiRequest(endpoint, { params: pageParams, headers });

    // Extract rows from this page
    let rows;
    if (transform) {
      rows = transform(body);
    } else if (Array.isArray(body)) {
      // Non-paginated: response is the array itself
      return body;
    } else if (body && Array.isArray(body.data)) {
      rows = body.data;
    } else {
      throw new Error(`Cannot extract rows from ${name} response — provide a transform function`);
    }

    if (!Array.isArray(rows)) {
      throw new Error(`Transform for ${name} did not return an array`);
    }

    allRows = allRows.concat(rows);

    // Determine total pages from pagination metadata
    if (body.pagination) {
      totalPages = body.pagination.totalPages || body.pagination.total_pages || 1;
      const total = body.pagination.total || body.pagination.totalCount || 0;
      if (page === 1) {
        console.log(`[fetch] ${name}: ${total} total records across ${totalPages} page(s)`);
      }
    } else if (body.meta) {
      // Alternative pagination shape
      totalPages = body.meta.totalPages || body.meta.total_pages || 1;
    } else {
      // No pagination metadata — assume single page
      break;
    }

    // If this page returned no rows, stop
    if (rows.length === 0) break;

    page++;
  }

  if (page > MAX_PAGES) {
    console.warn(`[fetch] ${name}: hit max page limit (${MAX_PAGES}), stopping`);
  }

  return allRows;
}

/**
 * Fetch a single dataset from the API and store it as a snapshot.
 *
 * @param {object} datasetConfig - Entry from config/datasets.mjs
 * @param {string} [date] - Override date (default: today)
 * @returns {Promise<{dataset: string, rowCount: number, snapshotId: number}>}
 */
async function fetchDataset(datasetConfig, date) {
  const {
    name,
    endpoint,
    rowKey,
    params = {},
    headers = {},
    transform = null,
    paginated = true,
  } = datasetConfig;

  console.log(`[fetch] Fetching dataset: ${name} from ${endpoint}`);

  let rows;
  if (paginated) {
    rows = await fetchAllPages(endpoint, params, headers, transform, name);
  } else {
    // Single non-paginated request
    const body = await apiRequest(endpoint, { params, headers });
    if (transform) {
      rows = transform(body);
    } else if (Array.isArray(body)) {
      rows = body;
    } else if (body && Array.isArray(body.data)) {
      rows = body.data;
    } else {
      throw new Error(`[fetch] Cannot extract rows from ${name} — provide a transform function`);
    }
  }

  if (!Array.isArray(rows)) {
    throw new Error(`[fetch] Transform for ${name} did not return an array`);
  }

  // Normalize into {key, data} pairs
  const normalizedRows = rows.map((row, idx) => {
    const key = row[rowKey];
    if (key === undefined || key === null) {
      throw new Error(
        `[fetch] Row ${idx} in ${name} is missing row key field "${rowKey}"`
      );
    }
    return { key: String(key), data: row };
  });

  // Ensure dataset record exists in DB
  const dataset = ensureDataset(name, endpoint, rowKey);

  // Store snapshot
  const result = insertSnapshot(dataset.id, date, normalizedRows);

  console.log(`[fetch] ${name}: stored ${result.rowCount} rows for ${date}`);

  return {
    dataset: name,
    datasetId: dataset.id,
    rowCount: result.rowCount,
    snapshotId: result.snapshotId,
  };
}

/**
 * Fetch all configured datasets and store snapshots.
 *
 * @param {string} [date] - Override date (default: today)
 * @returns {Promise<Array<{dataset: string, rowCount: number, snapshotId: number}>>}
 */
export async function fetchAllDatasets(date) {
  const fetchDate = date || today();
  console.log(`\n[fetch] Starting fetch for ${fetchDate}`);
  console.log(`[fetch] ${datasets.length} dataset(s) configured\n`);

  const results = [];

  for (const ds of datasets) {
    try {
      const result = await fetchDataset(ds, fetchDate);
      results.push(result);
    } catch (err) {
      console.error(`[fetch] ERROR fetching ${ds.name}: ${err.message}`);
      results.push({
        dataset: ds.name,
        error: err.message,
        rowCount: 0,
      });
    }
  }

  const successCount = results.filter(r => !r.error).length;
  console.log(`\n[fetch] Complete: ${successCount}/${datasets.length} datasets fetched successfully`);

  return results;
}
