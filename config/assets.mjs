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
    name: 'Digital One Flex (17040)',
    vulnerableId: '7d53603e-0973-437d-a3da-a129cb8108ef',
  },
  {
    name: 'Digital One LFI (12430)',
    vulnerableId: 'eb1148af-b67d-4e13-a07d-95d473a097a0',
  },
  {
    name: 'Consumer e-Banking Services (2466)',
    vulnerableId: 'b6473451-0525-41d7-8a81-0faad1edf1c4',
  },
];

export default assets;
