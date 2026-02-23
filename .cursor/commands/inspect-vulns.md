Run the vulnerability inspection script and show the output:

1. From the repo root, run: `node scripts/inspect-vulns.mjs`
2. Paste or summarize the output so we can review vuln snapshot coverage (row_count vs api_total), recent diffs, and any sample removed row_keys.

Use this when investigating why a dataset has incomplete vulns, comparing the three vulnerability apps, or checking for patterns in "removed" records.
