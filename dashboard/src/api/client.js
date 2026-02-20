const BASE = '/api';

/**
 * Fetch dashboard feature flags and config.
 * @returns {{ qualityTabEnabled: boolean }}
 */
export async function fetchConfig(options = {}) {
  const { data } = await apiFetch(`${BASE}/config`, {}, options);
  return data;
}

async function apiFetch(path, params = {}, options = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const fetchOpts = options.signal ? { signal: options.signal } : {};
  const res = await fetch(url.toString(), fetchOpts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchDatasets(category, options = {}) {
  const { data } = await apiFetch(`${BASE}/datasets`, { category }, options);
  return data;
}

export async function fetchDates(category, options = {}) {
  const { data } = await apiFetch(`${BASE}/dates`, { category }, options);
  return data;
}

export async function fetchDiffs(datasetId, limit, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/diffs`, { dataset_id: datasetId, limit, category }, options);
  return data;
}

export async function fetchDiff(id) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}`);
  return data;
}

export async function fetchDiffItems(id, changeType) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}/items`, { change_type: changeType });
  return data;
}

/**
 * Fetch IDs of all matching diff items (for cross-page selection).
 * @returns {{ ids: number[], total: number }}
 */
export async function fetchDiffItemIds(id, { changeType, search } = {}) {
  const params = {};
  if (changeType) params.change_type = changeType;
  if (search) params.search = search;
  const url = new URL(`${BASE}/diffs/${id}/items/ids`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

/**
 * Export diff as CSV. When ids provided, exports only those rows; otherwise all matching.
 * @returns {{ blob: Blob, filename: string }}
 */
export async function exportDiffCsv(id, { changeType, search, ids } = {}) {
  const baseUrl = `${window.location.origin}${BASE}/diffs/${id}/export`;
  let res;
  if (ids && ids.length > 0) {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } else {
    const params = new URLSearchParams();
    if (changeType) params.set('change_type', changeType);
    if (search) params.set('search', search);
    const qs = params.toString();
    res = await fetch(`${baseUrl}${qs ? `?${qs}` : ''}`);
  }
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const m = disp.match(/filename="?([^"]+)"?/);
  return { blob, filename: m ? m[1] : `diff-${id}.csv` };
}

/**
 * Fetch diff items with server-side pagination.
 * @returns {{ data: Array, pagination: { offset, limit, total } }}
 */
export async function fetchDiffItemsPage(id, { offset = 0, limit = 100, changeType, search, sort, dir } = {}) {
  return apiFetch(`${BASE}/diffs/${id}/items`, {
    offset,
    limit,
    change_type: changeType,
    search,
    sort,
    dir,
  });
}

export async function fetchSummary(date, category, options = {}) {
  const result = await apiFetch(`${BASE}/summary`, { date, category }, options);
  return result;
}

export async function fetchTrend(days, datasetId, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/trend`, { days, dataset_id: datasetId, category }, options);
  return data;
}

// ─── Quality / Data-Quality Endpoints ─────────────────────────

export async function fetchPopulation(days, datasetId, category) {
  const { data } = await apiFetch(`${BASE}/population`, { days, dataset_id: datasetId, category });
  return data;
}

export async function fetchFlapping(datasetId, days, category) {
  const { data } = await apiFetch(`${BASE}/quality/flapping`, { dataset_id: datasetId, days, category });
  return data;
}

export async function fetchFieldStability(datasetId, days, category) {
  const { data } = await apiFetch(`${BASE}/quality/field-stability`, { dataset_id: datasetId, days, category });
  return data;
}

export async function fetchSourceSegments(datasetId, date, category) {
  const { data } = await apiFetch(`${BASE}/quality/source-segments`, { dataset_id: datasetId, date, category });
  return data;
}

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, backend returns latest.
 */
export async function fetchReferential(date) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/quality/referential`, params);
  return data;
}

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, backend returns latest.
 */
export async function fetchAssertions(date) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/quality/assertions`, params);
  return data;
}

export async function fetchAssertionHistory(assertionId, days) {
  const { data } = await apiFetch(`${BASE}/quality/assertions/history`, { assertion_id: assertionId, days });
  return data;
}

export async function fetchAssertionSummary(days) {
  const { data } = await apiFetch(`${BASE}/quality/assertions/summary`, { days });
  return data;
}

// ─── Executive Report ────────────────────────────────────────────

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, returns latest.
 */
export async function fetchReport(date) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/report`, params);
  return data;
}

export async function fetchReportDates() {
  const { data } = await apiFetch(`${BASE}/report/dates`);
  return data;
}
