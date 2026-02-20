import { gzipSync } from 'node:zlib';
import {
  listDatasets,
  listDiffs,
  getDiff,
  getDiffItems,
  getDiffItemsPaginated,
  getDiffItemIds,
  getDiffItemsByIds,
  getSummaryForDate,
  getTrend,
  getAvailableDates,
  getPopulationTrend,
  getExecutiveReport,
  getReportDates,
} from '../db/queries.mjs';
import {
  getFlappingRows,
  getFieldStability,
  getSourceSegments,
  checkReferentialIntegrity,
  getAssertionResults,
  getAssertionHistory,
  getAssertionSummary,
} from '../analysis/queries.mjs';
import config from '../../config/default.mjs';

/**
 * Set up all API routes for the dashboard.
 */
export function setupRoutes(app) {

  // ─── GET /api/config ────────────────────────────────────────────
  app.get('/api/config', (_req, res) => {
    res.json({
      data: {
        qualityTabEnabled: config.features.qualityTab,
      },
    });
  });

  // ─── GET /api/datasets ──────────────────────────────────────────
  app.get('/api/datasets', (req, res) => {
    try {
      const { category } = req.query;
      const datasets = listDatasets(category || null);
      res.json({ data: datasets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/dates ─────────────────────────────────────────────
  app.get('/api/dates', (req, res) => {
    try {
      const { category } = req.query;
      const dates = getAvailableDates(category || null);
      res.json({ data: dates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs ─────────────────────────────────────────────
  app.get('/api/diffs', (req, res) => {
    try {
      const { dataset_id, limit, category } = req.query;
      const diffs = listDiffs(
        dataset_id ? parseInt(dataset_id, 10) : null,
        limit ? parseInt(limit, 10) : 90,
        category || null
      );
      res.json({ data: diffs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id ─────────────────────────────────────────
  app.get('/api/diffs/:id', (req, res) => {
    try {
      const diff = getDiff(parseInt(req.params.id, 10));
      if (!diff) {
        return res.status(404).json({ error: 'Diff not found' });
      }
      res.json({ data: diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id/items ───────────────────────────────────
  // Supports server-side pagination for large diffs (30k+ rows).
  // Query params: offset, limit, change_type, search, sort, dir
  app.get('/api/diffs/:id/items', (req, res) => {
    try {
      const diffId = parseInt(req.params.id, 10);
      const {
        offset = '0',
        limit = '100',
        change_type,
        search,
        sort = 'change_type',
        dir = 'ASC',
      } = req.query;

      const { rows, total } = getDiffItemsPaginated(diffId, {
        offset: parseInt(offset, 10),
        limit: parseInt(limit, 10),
        changeType: change_type || null,
        search: search || null,
        sortField: sort,
        sortDir: dir,
      });

      // Parse JSON fields and reconstruct old_data/new_data for the dashboard.
      // DB stores slim format: row_data + field_changes (only changed field values).
      // We reconstruct old_data/new_data so the grid cell renderer can show diffs.
      const parsed = rows.map(item => {
        const rowData = item.row_data ? JSON.parse(item.row_data) : null;
        const fieldChanges = item.field_changes ? JSON.parse(item.field_changes) : null;
        const changedFields = item.changed_fields ? JSON.parse(item.changed_fields) : null;

        let oldData = null;
        let newData = null;

        if (item.change_type === 'added') {
          newData = rowData;
        } else if (item.change_type === 'removed') {
          oldData = rowData;
        } else if (item.change_type === 'modified') {
          newData = rowData;
          // Reconstruct old_data from new row + field changes
          if (rowData && fieldChanges) {
            oldData = { ...rowData };
            for (const [field, change] of Object.entries(fieldChanges)) {
              oldData[field] = change.old;
            }
          }
        }

        return {
          ...item,
          row_data: undefined, // Don't send raw column to client
          field_changes: undefined,
          old_data: oldData,
          new_data: newData,
          changed_fields: changedFields,
        };
      });

      res.json({
        data: parsed,
        pagination: {
          offset: parseInt(offset, 10),
          limit: parseInt(limit, 10),
          total,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id/items/ids ───────────────────────────────
  // Lightweight endpoint: IDs of all matching rows (for cross-page selection).
  app.get('/api/diffs/:id/items/ids', (req, res) => {
    try {
      const diffId = parseInt(req.params.id, 10);
      const diff = getDiff(diffId);
      if (!diff) {
        return res.status(404).json({ error: 'Diff not found' });
      }
      const { change_type, search } = req.query;
      const { ids, total } = getDiffItemIds(diffId, {
        changeType: change_type || null,
        search: search || null,
      });
      res.json({ ids, total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id/export ─────────────────────────────────
  // Export all matching diff items as CSV (respects change_type and search filters).
  // Accepts gzip when client sends Accept-Encoding: gzip.
  app.get('/api/diffs/:id/export', (req, res) => {
    try {
      const diffId = parseInt(req.params.id, 10);
      const diff = getDiff(diffId);
      if (!diff) {
        return res.status(404).json({ error: 'Diff not found' });
      }
      const { change_type, search } = req.query;
      const { rows } = getDiffItemsPaginated(diffId, {
        offset: 0,
        limit: 1_000_000,
        changeType: change_type || null,
        search: search || null,
        sortField: 'change_type',
        sortDir: 'ASC',
      });
      const csv = buildCsvFromRows(rows);
      sendCsvResponse(res, diff, csv, req.headers['accept-encoding']?.includes('gzip'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/diffs/:id/export ─────────────────────────────────
  // Export only selected rows. Body: { ids: number[] }.
  app.post('/api/diffs/:id/export', (req, res) => {
    try {
      const diffId = parseInt(req.params.id, 10);
      const diff = getDiff(diffId);
      if (!diff) {
        return res.status(404).json({ error: 'Diff not found' });
      }
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : null;
      if (!ids || ids.length === 0) {
        return res.status(400).json({ error: 'ids array required and must not be empty' });
      }
      const rows = getDiffItemsByIds(diffId, ids);
      const csv = buildCsvFromRows(rows);
      sendCsvResponse(res, diff, csv, req.headers['accept-encoding']?.includes('gzip'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/summary ──────────────────────────────────────────
  app.get('/api/summary', (req, res) => {
    try {
      const { date, category } = req.query;
      const cat = category || null;
      if (!date) {
        // Default to most recent date (within category)
        const dates = getAvailableDates(cat);
        if (dates.length === 0) {
          return res.json({ data: [], date: null });
        }
        const summary = getSummaryForDate(dates[0], cat);
        return res.json({ data: summary, date: dates[0] });
      }
      const summary = getSummaryForDate(date, cat);
      res.json({ data: summary, date });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/report ─────────────────────────────────────────────
  app.get('/api/report', (req, res) => {
    try {
      const { date } = req.query;
      const report = getExecutiveReport(date || null);
      if (!report) {
        return res.status(404).json({ error: 'No executive report found' });
      }
      res.json({ data: report });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/report/dates ───────────────────────────────────────
  app.get('/api/report/dates', (req, res) => {
    try {
      const dates = getReportDates();
      res.json({ data: dates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/trend ─────────────────────────────────────────────
  app.get('/api/trend', (req, res) => {
    try {
      const { days, dataset_id, category } = req.query;
      const trend = getTrend(
        days ? parseInt(days, 10) : 30,
        dataset_id ? parseInt(dataset_id, 10) : null,
        category || null
      );
      res.json({ data: trend.reverse() }); // chronological order
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/population ───────────────────────────────────────
  // Population trend: daily row_count and api_total from snapshots.
  // Use this to detect pipeline failures (sudden drops) and data drift
  // (api_total vs row_count mismatch).
  app.get('/api/population', (req, res) => {
    try {
      const { days, dataset_id, category } = req.query;
      const data = getPopulationTrend(
        days ? parseInt(days, 10) : 30,
        dataset_id ? parseInt(dataset_id, 10) : null,
        category || null
      );
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Quality Endpoints
  // ═══════════════════════════════════════════════════════════════

  // ─── GET /api/quality/flapping ────────────────────────────────
  app.get('/api/quality/flapping', (req, res) => {
    try {
      const { dataset_id, days, category } = req.query;
      const data = getFlappingRows(
        dataset_id ? parseInt(dataset_id, 10) : null,
        days ? parseInt(days, 10) : 7,
        category || null
      );
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/field-stability ─────────────────────────
  app.get('/api/quality/field-stability', (req, res) => {
    try {
      const { dataset_id, days, category } = req.query;
      const data = getFieldStability(
        dataset_id ? parseInt(dataset_id, 10) : null,
        days ? parseInt(days, 10) : 30,
        category || null
      );
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/source-segments ─────────────────────────
  app.get('/api/quality/source-segments', (req, res) => {
    try {
      const { dataset_id, date, category } = req.query;
      const data = getSourceSegments(
        dataset_id ? parseInt(dataset_id, 10) : null,
        date || null,
        category || null
      );
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/referential ─────────────────────────────
  app.get('/api/quality/referential', (req, res) => {
    try {
      const { date } = req.query;
      const data = checkReferentialIntegrity(date || null);
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/assertions ──────────────────────────────
  app.get('/api/quality/assertions', (req, res) => {
    try {
      const { date } = req.query;
      const data = getAssertionResults(date || null);
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/assertions/summary ────────────────────────
  app.get('/api/quality/assertions/summary', (req, res) => {
    try {
      const { days } = req.query;
      const data = getAssertionSummary(days ? parseInt(days, 10) : 30);
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/quality/assertions/history ──────────────────────
  app.get('/api/quality/assertions/history', (req, res) => {
    try {
      const { assertion_id, days } = req.query;
      if (!assertion_id) {
        return res.status(400).json({ error: 'assertion_id is required' });
      }
      const data = getAssertionHistory(
        assertion_id,
        days ? parseInt(days, 10) : 30
      );
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ─── CSV helpers ──────────────────────────────────────────────────

function formatCsvVal(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvFromRows(rows) {
  const fieldSet = new Set();
  const parsed = rows.map((item) => {
    const rowData = item.row_data ? JSON.parse(item.row_data) : {};
    const fieldChanges = item.field_changes ? JSON.parse(item.field_changes) : null;
    const changedFields = item.changed_fields ? JSON.parse(item.changed_fields) : [];
    Object.keys(rowData).forEach((k) => fieldSet.add(k));
    let oldData = null;
    if (item.change_type === 'modified' && fieldChanges) {
      oldData = { ...rowData };
      for (const [field, change] of Object.entries(fieldChanges)) {
        oldData[field] = change.old;
      }
    }
    return { row_key: item.row_key, change_type: item.change_type, changed_fields: changedFields, rowData, oldData };
  });
  const dataFields = Array.from(fieldSet).sort();
  const csvHeader = ['row_key', 'change_type', 'changed_fields', ...dataFields];
  const csvRows = parsed.map((item) => {
    const values = [
      csvEscape(item.row_key),
      csvEscape(item.change_type),
      csvEscape((item.changed_fields || []).join('; ')),
    ];
    for (const field of dataFields) {
      const val = item.rowData[field];
      if (item.change_type === 'modified' && item.changed_fields?.includes(field) && item.oldData) {
        values.push(csvEscape(`${formatCsvVal(item.oldData[field])} → ${formatCsvVal(val)}`));
      } else {
        values.push(csvEscape(formatCsvVal(val)));
      }
    }
    return values.join(',');
  });
  return [csvHeader.join(','), ...csvRows].join('\n');
}

function sendCsvResponse(res, diff, csv, useGzip) {
  const filename = `${diff.dataset_name}_${diff.from_date}_to_${diff.to_date}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (useGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.send(gzipSync(Buffer.from(csv, 'utf-8')));
  } else {
    res.send(csv);
  }
}
