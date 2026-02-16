#!/usr/bin/env node

import { Command } from 'commander';
import { fetchAllDatasets } from './api/fetcher.mjs';
import { diffAllDatasets } from './diff/engine.mjs';
import { closeDb, getDb } from './db/index.mjs';
import { closeClient } from './api/client.mjs';
import {
  listDatasets,
  listDiffs,
  getAvailableDates,
  pruneSnapshots,
} from './db/queries.mjs';
import { runAssertions } from './analysis/assertions.mjs';
import config from '../config/default.mjs';
import { log, warn, error } from './lib/logger.mjs';

const program = new Command();

program
  .name('daydiff')
  .description('Daily data diff reporter')
  .version('1.0.0');

// ─── fetch ───────────────────────────────────────────────────────

program
  .command('fetch')
  .description('Fetch today\'s datasets from the API and store snapshots')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      const results = await fetchAllDatasets(opts.date);
      const failed = results.filter(r => r.error);
      if (failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      error(`[fetch] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
      closeDb();
    }
  });

// ─── diff ────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Compute diff between today and previous day\'s snapshots')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      diffAllDatasets(opts.date);
    } catch (err) {
      error(`[diff] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      closeDb();
    }
  });

// ─── run ─────────────────────────────────────────────────────────

program
  .command('run')
  .description('Fetch datasets then compute diffs (daily job)')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      log('═══════════════════════════════════════════');
      log('  DayDiff — Daily Run');
      log('═══════════════════════════════════════════');

      const fetchResults = await fetchAllDatasets(opts.date);
      const fetchFailed = fetchResults.filter(r => r.error);

      diffAllDatasets(opts.date);

      // Run quality assertions
      const today = opts.date || new Date().toISOString().slice(0, 10);
      const assertionResults = runAssertions(today);
      const failed = assertionResults.filter(r => !r.passed);
      if (failed.length > 0) {
        warn(`\n[quality] ${failed.length} assertion(s) failed:`);
        for (const f of failed) {
          warn(`  ✗ ${f.name}: ${f.message}`);
        }
      } else if (assertionResults.length > 0) {
        log(`\n[quality] All ${assertionResults.length} assertion(s) passed`);
      }

      // Auto-prune old snapshots
      const retentionDays = config.retention.snapshotDays;
      const pruneResult = pruneSnapshots(retentionDays);
      if (pruneResult.deletedSnapshots > 0) {
        log(
          `\n[prune] Cleaned up ${pruneResult.deletedSnapshots} snapshot(s) ` +
          `and ${pruneResult.deletedRows} row(s) older than ${retentionDays} days`
        );
      }

      if (fetchFailed.length > 0) {
        warn(`\n⚠  ${fetchFailed.length} dataset(s) had fetch errors`);
        process.exitCode = 1;
      }

      log('\n═══════════════════════════════════════════');
      log('  Run complete');
      log('═══════════════════════════════════════════\n');
    } catch (err) {
      error(`[run] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
      closeDb();
    }
  });

// ─── dashboard ───────────────────────────────────────────────────

program
  .command('dashboard')
  .description('Start the dashboard web server')
  .option('-p, --port <port>', 'Port number', undefined)
  .action(async (opts) => {
    try {
      // Dynamic import to avoid loading Express unless needed
      const { startServer } = await import('./server/index.mjs');
      const port = opts.port ? parseInt(opts.port, 10) : undefined;
      await startServer(port);
    } catch (err) {
      error(`[dashboard] Fatal error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ─── status ──────────────────────────────────────────────────────

program
  .command('status')
  .description('Show latest fetch/diff summary')
  .action(() => {
    try {
      // Initialize DB
      getDb();

      const allDatasets = listDatasets();
      const dates = getAvailableDates();

      log('\n═══════════════════════════════════════════');
      log('  DayDiff — Status');
      log('═══════════════════════════════════════════\n');

      if (allDatasets.length === 0) {
        log('  No datasets have been fetched yet.');
        log('  Run: node src/cli.mjs fetch\n');
        return;
      }

      log(`  Datasets: ${allDatasets.length}`);
      for (const ds of allDatasets) {
        log(`    - ${ds.name} (key: ${ds.row_key})`);
      }

      log(`\n  Diff dates available: ${dates.length}`);
      if (dates.length > 0) {
        log(`  Latest: ${dates[0]}`);
        log(`  Oldest: ${dates[dates.length - 1]}`);
      }

      // Show latest diffs
      const recentDiffs = listDiffs(null, 10);
      if (recentDiffs.length > 0) {
        log('\n  Recent diffs:');
        for (const d of recentDiffs) {
          log(
            `    ${d.to_date} | ${d.dataset_name} | ` +
            `+${d.added_count} -${d.removed_count} ~${d.modified_count} =${d.unchanged_count}`
          );
        }
      }

      log('\n═══════════════════════════════════════════\n');
    } catch (err) {
      error(`[status] Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      closeDb();
    }
  });

// ─── prune ──────────────────────────────────────────────────────

program
  .command('prune')
  .description('Delete old snapshots to reclaim disk space (keeps diffs)')
  .option('--days <days>', 'Retention period in days', undefined)
  .action((opts) => {
    try {
      getDb();

      const retentionDays = opts.days
        ? parseInt(opts.days, 10)
        : config.retention.snapshotDays;

      log(`\n[prune] Pruning snapshots older than ${retentionDays} days...`);

      const result = pruneSnapshots(retentionDays);

      if (result.deletedSnapshots === 0) {
        log('[prune] Nothing to prune.');
      } else {
        log(
          `[prune] Deleted ${result.deletedSnapshots} snapshot(s) ` +
          `and ${result.deletedRows} row(s).`
        );
      }

      log('[prune] Done.\n');
    } catch (err) {
      error(`[prune] Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      closeDb();
    }
  });

// ─── install-schedule ────────────────────────────────────────────

program
  .command('install-schedule')
  .description('Install macOS launchd daily job')
  .action(async () => {
    try {
      const { installLaunchd } = await import('./scheduler/launchd.mjs');
      installLaunchd();
    } catch (err) {
      error(`[schedule] Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse();
