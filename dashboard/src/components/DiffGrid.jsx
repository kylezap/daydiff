import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { AllCommunityModule, themeQuartz, colorSchemeDarkBlue } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { fetchDiffItemsPage } from '../api/client.js';

const modules = [AllCommunityModule];
const darkTheme = themeQuartz.withPart(colorSchemeDarkBlue);
const PAGE_SIZE = 100;

/**
 * Custom cell renderer that shows old vs new values for modified fields.
 */
function DiffCellRenderer(params) {
  const { value, data, colDef } = params;
  const fieldName = colDef.field;

  if (!data) return null;

  const changeType = data._changeType;
  const changedFields = data._changedFields || [];
  const oldData = data._oldData || {};
  const newData = data._newData || {};

  // For the change_type column
  if (fieldName === '_changeType') {
    const badgeColors = {
      added: { bg: '#0d1f0d', color: '#3fb950', border: '#238636' },
      removed: { bg: '#1f0d0d', color: '#f85149', border: '#da3633' },
      modified: { bg: '#1f1a0d', color: '#e3b341', border: '#d29922' },
    };
    const c = badgeColors[value] || badgeColors.modified;
    return (
      <span style={{
        background: c.bg,
        color: c.color,
        border: `1px solid ${c.border}`,
        borderRadius: 12,
        padding: '2px 10px',
        fontSize: '0.75rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        {value}
      </span>
    );
  }

  // For data fields: show diff highlighting if field was changed
  if (changeType === 'modified' && changedFields.includes(fieldName)) {
    const oldVal = oldData[fieldName];
    const newVal = newData[fieldName];
    return (
      <span>
        <span style={{ textDecoration: 'line-through', color: '#f85149', opacity: 0.7, marginRight: 6 }}>
          {formatValue(oldVal)}
        </span>
        <span style={{ color: '#3fb950' }}>
          {formatValue(newVal)}
        </span>
      </span>
    );
  }

  if (changeType === 'added') {
    return <span style={{ color: '#3fb950' }}>{formatValue(value)}</span>;
  }

  if (changeType === 'removed') {
    return <span style={{ color: '#f85149' }}>{formatValue(value)}</span>;
  }

  return <span>{formatValue(value)}</span>;
}

function formatValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Transform raw API items into AG Grid row data and build column defs.
 */
function buildGridData(items) {
  if (!items || items.length === 0) return { columnDefs: [], rowData: [] };

  const fieldSet = new Set();
  for (const item of items) {
    const data = item.new_data || item.old_data || {};
    Object.keys(data).forEach((k) => fieldSet.add(k));
  }

  const fields = Array.from(fieldSet);

  const hasName = fields.includes('name');
  const nameIdx = fields.indexOf('name');
  const rowKeyCol = {
    field: '_rowKey',
    headerName: 'Row Key',
    width: 150,
    pinned: 'left',
    colId: '_rowKey',
  };
  const rowKeyColUnpinned = { ...rowKeyCol, pinned: undefined, colId: '_rowKey_unpinned' };
  const nameCol = {
    field: 'name',
    headerName: 'Name',
    minWidth: 120,
    flex: 1,
    pinned: 'left',
    cellRenderer: DiffCellRenderer,
    colId: 'name',
  };
  // Build data columns, excluding 'name' when we have a dedicated nameCol to avoid duplicates
  const otherFields = hasName ? fields.filter((f) => f !== 'name') : fields;
  const baseDataCols = otherFields.map((f) => ({
    field: f,
    headerName: f,
    minWidth: 120,
    flex: 1,
    cellRenderer: DiffCellRenderer,
  }));
  // When hasName, insert Row Key at name's original position (swap)
  const dataCols =
    hasName && nameIdx >= 0
      ? [...baseDataCols.slice(0, nameIdx), rowKeyColUnpinned, ...baseDataCols.slice(nameIdx)]
      : baseDataCols;
  const secondCol = hasName ? nameCol : rowKeyCol;
  const columnDefs = [
    {
      field: '_changeType',
      headerName: 'Change',
      width: 120,
      pinned: 'left',
      cellRenderer: DiffCellRenderer,
    },
    secondCol,
    ...dataCols,
  ];

  const rowData = items.map((item) => {
    const current = item.new_data || item.old_data || {};
    return {
      _id: item.id,
      _changeType: item.change_type,
      _rowKey: item.row_key,
      _changedFields: item.changed_fields || [],
      _oldData: item.old_data || {},
      _newData: item.new_data || {},
      ...current,
    };
  });

  return { columnDefs, rowData };
}

/**
 * DiffGrid — AG Grid with server-side pagination for large diff datasets.
 *
 * Props:
 *   diffId      — ID of the diff to display
 *   changeType  — Optional change_type filter (null = all)
 *   quickFilter — Text to search across all columns
 *   onTotalChange — Callback when total row count changes
 *   onRowClick  — Optional callback when a row is clicked (receives row data)
 */
export default function DiffGrid({ diffId, changeType, quickFilter, onTotalChange, onRowClick }) {
  const gridRef = useRef(null);
  const [rowData, setRowData] = useState([]);
  const [columnDefs, setColumnDefs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);

  // Debounced search — avoid hammering server on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState(quickFilter);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(quickFilter), 300);
    return () => clearTimeout(timer);
  }, [quickFilter]);

  // Reset to page 0 when filters change
  useEffect(() => {
    setPage(0);
  }, [diffId, changeType, debouncedSearch]);

  // Fetch page data
  useEffect(() => {
    if (!diffId) return;

    let cancelled = false;
    async function loadPage() {
      setLoading(true);
      try {
        const result = await fetchDiffItemsPage(diffId, {
          offset: page * pageSize,
          limit: pageSize,
          changeType: changeType || undefined,
          search: debouncedSearch || undefined,
        });

        if (cancelled) return;

        const { columnDefs: cols, rowData: rows } = buildGridData(result.data);
        setColumnDefs(cols);
        setRowData(rows);
        setTotal(result.pagination.total);
        if (onTotalChange) onTotalChange(result.pagination.total);
      } catch (err) {
        console.error('Failed to load diff items:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPage();
    return () => { cancelled = true; };
  }, [diffId, page, pageSize, changeType, debouncedSearch, onTotalChange]);

  const totalPages = Math.ceil(total / pageSize);

  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    minWidth: 80,
  }), []);

  const getRowStyle = useCallback((params) => {
    if (!params.data) return {};
    const base = {};
    if (onRowClick) base.cursor = 'pointer';
    switch (params.data._changeType) {
      case 'added':
        return { ...base, background: 'rgba(63, 185, 80, 0.05)' };
      case 'removed':
        return { ...base, background: 'rgba(248, 81, 73, 0.05)' };
      case 'modified':
        return { ...base, background: 'rgba(227, 179, 65, 0.03)' };
      default:
        return base;
    }
  }, [onRowClick]);

  const [exporting, setExporting] = useState(false);

  const handleExportCsv = useCallback(async () => {
    if (!diffId) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (changeType) params.set('change_type', changeType);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const qs = params.toString();
      const url = `/api/diffs/${diffId}/export${qs ? `?${qs}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();

      // Extract filename from Content-Disposition or build a default
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `diff-${diffId}.csv`;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('CSV export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [diffId, changeType, debouncedSearch]);

  if (!diffId) {
    return (
      <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>
        No diff selected. Choose a diff from the overview or date picker.
      </div>
    );
  }

  return (
    <AgGridProvider modules={modules}>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 320px)', minHeight: 400 }}>
        {/* Grid */}
        <div style={{ flex: 1, opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          <AgGridReact
            ref={gridRef}
            theme={darkTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowStyle={getRowStyle}
            onRowClicked={(e) => onRowClick?.(e.data)}
            animateRows={false}
            enableCellTextSelection={false}
            suppressCellFocus={true}
            getRowId={(params) => String(params.data._id)}
            suppressPaginationPanel={true}
          />
        </div>

        {/* Custom pagination bar */}
        <div style={paginationBar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>
              {total.toLocaleString()} total items
            </span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
              style={selectStyle}
            >
              {[50, 100, 250, 500].map(n => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </select>
            <button
              onClick={handleExportCsv}
              disabled={exporting || total === 0}
              style={exportBtnStyle}
              title="Export all matching rows as CSV"
            >
              {exporting ? 'Exporting…' : '⬇ Export CSV'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <button
              onClick={() => setPage(0)}
              disabled={page === 0}
              style={pageBtnStyle}
              title="First page"
            >
              &#x21E4;
            </button>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              style={pageBtnStyle}
            >
              &#9664;
            </button>
            <span style={{ color: '#e1e4e8', fontSize: '0.8rem', minWidth: 80, textAlign: 'center' }}>
              {total > 0 ? `${page + 1} / ${totalPages}` : '—'}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={pageBtnStyle}
            >
              &#9654;
            </button>
            <button
              onClick={() => setPage(totalPages - 1)}
              disabled={page >= totalPages - 1}
              style={pageBtnStyle}
              title="Last page"
            >
              &#x21E5;
            </button>
          </div>
        </div>
      </div>
    </AgGridProvider>
  );
}

const paginationBar = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.5rem 0.25rem',
  borderTop: '1px solid #30363d',
  marginTop: '0.25rem',
};

const pageBtnStyle = {
  background: '#21262d',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 4,
  padding: '0.25rem 0.6rem',
  cursor: 'pointer',
  fontSize: '0.8rem',
  lineHeight: 1,
};

const selectStyle = {
  background: '#161b22',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 4,
  padding: '0.25rem 0.4rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};

const exportBtnStyle = {
  background: '#21262d',
  color: '#58a6ff',
  border: '1px solid #30363d',
  borderRadius: 4,
  padding: '0.25rem 0.65rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};
