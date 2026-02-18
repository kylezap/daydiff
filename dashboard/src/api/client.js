const BASE = '/api';

async function apiFetch(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchDatasets(category) {
  const { data } = await apiFetch(`${BASE}/datasets`, { category });
  return data;
}

export async function fetchDates(category) {
  const { data } = await apiFetch(`${BASE}/dates`, { category });
  return data;
}

export async function fetchDiffs(datasetId, limit, category) {
  const { data } = await apiFetch(`${BASE}/diffs`, { dataset_id: datasetId, limit, category });
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

export async function fetchSummary(date, category) {
  const result = await apiFetch(`${BASE}/summary`, { date, category });
  return result;
}

export async function fetchTrend(days, datasetId, category) {
  const { data } = await apiFetch(`${BASE}/trend`, { days, dataset_id: datasetId, category });
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

export async function fetchReferential(date) {
  const { data } = await apiFetch(`${BASE}/quality/referential`, { date });
  return data;
}

export async function fetchAssertions(date) {
  const { data } = await apiFetch(`${BASE}/quality/assertions`, { date });
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
