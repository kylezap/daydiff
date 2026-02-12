/**
 * Tracked Assets
 *
 * Each entry represents an application / repository whose vulnerabilities
 * you want to track daily.  Adding a new asset is a one-liner:
 *
 *   { name: 'my-service', vulnerableId: '<uuid from DevGrid>' },
 *
 * Fields:
 *   name         — Friendly label (used in DB, dashboard, and logs).
 *                  Keep it short and unique — no spaces.
 *   vulnerableId — The DevGrid asset UUID.  Find it in the DevGrid UI or
 *                  via GET /applications, GET /repositories, etc.
 *                  This is passed as ?vulnerableId=<uuid> to /vulnerabilities.
 */

const assets = [
  // ── Add your tracked applications here ───────────────────────
  {
    name: 'app-one',
    vulnerableId: '14750e99-5a36-4279-997f-657af45e0185',
  },
  // {
  //   name: 'app-two',
  //   vulnerableId: '<paste-uuid-here>',
  // },
  // {
  //   name: 'app-three',
  //   vulnerableId: '<paste-uuid-here>',
  // },
];

export default assets;
