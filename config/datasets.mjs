/**
 * DevGrid API Dataset Definitions
 *
 * Each entry describes a dataset to fetch daily from the DevGrid API.
 * The fetcher auto-paginates responses that follow the DevGrid pattern:
 *   { data: [...], pagination: { page, limit, total, totalPages } }
 *
 * Fields:
 *   name       — Unique human-readable name (used in DB + dashboard)
 *   endpoint   — API path appended to API_BASE_URL
 *   rowKey     — Field in each row used as its unique identifier
 *   paginated  — Whether the endpoint returns paginated results (default: true)
 *   params     — Optional default query parameters
 *   headers    — Optional extra headers for this endpoint
 *   transform  — Optional function to normalize the response into a row array.
 */

const datasets = [
  // ──────────────────────────────────────────────────────────────
  // Active — verified working with current API key
  // ──────────────────────────────────────────────────────────────
  {
    name: 'applications',
    endpoint: '/applications',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'repositories',
    endpoint: '/repositories',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'entities',
    endpoint: '/entities',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'blueprints',
    endpoint: '/blueprints',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // Disabled — uncomment as access is granted or issues resolved
  // ──────────────────────────────────────────────────────────────

  // Returns non-JSON (plain text error) — may need different endpoint or params
  // {
  //   name: 'components',
  //   endpoint: '/components',
  //   rowKey: 'id',
  //   paginated: true,
  // },

  // Returns non-JSON (plain text error)
  // {
  //   name: 'committers',
  //   endpoint: '/committers',
  //   rowKey: 'id',
  //   paginated: true,
  // },

  // 500 Internal Server Error
  // {
  //   name: 'relationships',
  //   endpoint: '/relationships',
  //   rowKey: 'id',
  //   paginated: true,
  // },

  // 403 Forbidden — API key lacks permission
  // {
  //   name: 'entity-mappings',
  //   endpoint: '/entity-mappings',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'incidents',
  //   endpoint: '/incidents',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'resources',
  //   endpoint: '/resources',
  //   rowKey: 'id',
  //   paginated: true,
  // },

  // 400 Bad Request — likely requires specific query params
  // {
  //   name: 'vulnerabilities',
  //   endpoint: '/vulnerabilities',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'vulnerability-projects',
  //   endpoint: '/vulnerability-projects',
  //   rowKey: 'id',
  //   paginated: true,
  // },

  // Returns HTML — endpoint may not be available
  // {
  //   name: 'vulnerability-identifiers',
  //   endpoint: '/vulnerability-identifiers',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'api-catalog-apis',
  //   endpoint: '/api-catalog/apis',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'api-catalog-policies',
  //   endpoint: '/api-catalog/policies',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'api-catalog-compliance-reports',
  //   endpoint: '/api-catalog/compliance-reports',
  //   rowKey: 'id',
  //   paginated: true,
  // },
];

export default datasets;
