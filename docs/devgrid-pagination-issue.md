# Pagination Issue: Unstable sort order causes incomplete data retrieval

## Summary

The DevGrid API's paginated endpoints (`/applications`, `/components`, `/resources`, `/repositories`, `/vulnerabilities`) do not support server-side sorting. Without a stable sort order, offset-based pagination returns inconsistent results across requests—rows shift between pages, and some records never appear no matter how many passes are made.

**Impact:** Clients cannot reliably fetch complete datasets. Testing shows ~80% coverage on large tables (e.g., ~11,500 of 14,089 records on `/repositories`).

---

## Current API behavior

Pagination works via `limit` and `offset` query parameters:

```
GET /vulnerabilities?vulnerableId=<uuid>&limit=200&offset=0
```

The response includes pagination metadata:

```json
{
  "pagination": {
    "page": 1,
    "limit": 200,
    "offset": 0,
    "total": 5352,
    "links": { ... }
  },
  "data": [ ... ]
}
```

**Problem:** The ordering of rows in the response is not stable. Between two sequential requests (e.g., `offset=0` then `offset=200`), the underlying data may have been reordered—perhaps due to database updates, lack of an explicit ORDER BY, or internal query optimization. As a result:

1. Rows can appear on multiple pages (duplicates)
2. Rows can disappear from the window entirely (skipped)
3. Repeated full fetches yield different subsets of records

---

## Affected endpoints

- `GET /applications`
- `GET /components`
- `GET /resources`
- `GET /repositories`
- `GET /vulnerabilities`

Any endpoint that returns paginated results with `limit` and `offset`.

---

## Reproduction

1. Fetch the first page:
   ```
   GET /repositories?limit=200&offset=0
   ```
   Note the record IDs returned (e.g., first 200 IDs).

2. Fetch the second page:
   ```
   GET /repositories?limit=200&offset=200
   ```
   Note the record IDs returned.

3. Perform a full pagination pass (offset 0, 200, 400, … up to `total`).

4. Compare the union of all fetched IDs against `total` from the first response.

**Expected:** Union of IDs = `total` (no duplicates, no gaps).

**Actual:** Union of IDs < `total` (some records never appear; overlap mitigates but does not eliminate the gap).

---

## Proposed solution

Add support for a `sort` parameter to ensure stable ordering:

```
GET /repositories?limit=200&offset=200&sort=id&order=asc
```

**Suggested parameter names:**
- `sort` — Column/field to sort by (e.g., `id`, `createdAt`, `name`)
- `order` — `asc` or `desc` (optional, default `asc`)

**Minimum viable:** A single stable default sort (e.g., `id ASC`) applied when no sort is specified would resolve the issue, though explicit `sort`/`order` would give clients more control.

---

## Why this matters

Clients building reporting, auditing, or data-sync tools need to fetch complete datasets reliably. Without stable pagination:

- Daily snapshots are incomplete and inconsistent
- Compliance and audit workflows cannot guarantee full coverage
- Integrations must implement workarounds (overlapping pages, multiple passes) that increase API load and still don't guarantee 100% retrieval

---

## References

- Pagination uses `limit` and `offset` (per response `pagination` object and link URLs)
- Tested against `prod.api.devgrid.io`
- Issue observed across multiple endpoints and account sizes
