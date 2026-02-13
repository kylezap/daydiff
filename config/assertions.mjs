/**
 * Assertion rules for automated data quality checks.
 *
 * Each rule defines:
 *   id       — unique identifier (used in assertion_results)
 *   name     — human-readable label
 *   check    — the built-in check type to run
 *   ...opts  — check-specific thresholds / config
 *   category — (optional) limit to datasets of this category
 */
export default [
  {
    id: 'population-drop',
    name: 'Population drop within 10%',
    check: 'population-drop',
    threshold: 0.10,
    category: 'vulnerability',
  },
  {
    id: 'fetch-complete',
    name: 'Fetch completeness',
    check: 'fetch-complete',
  },
  {
    id: 'no-flapping-7d',
    name: 'No flapping records (7-day window)',
    check: 'no-flapping',
    windowDays: 7,
    maxFlaps: 2,
    category: 'vulnerability',
  },
  {
    id: 'referential-integrity',
    name: 'Vulnerability references valid assets',
    check: 'referential-integrity',
  },
];
