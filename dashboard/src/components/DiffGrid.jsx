import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { AllCommunityModule, themeQuartz, colorSchemeDarkBlue } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { fetchDiffItemsPage, fetchDiffItemIds, exportDiffCsv } from '../api/client.js';

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

/** Checkbox for row selection (cross-page, managed via selectedIds). */
function CheckboxCellRenderer({ data, colDef }) {
  if (!data) return null;
  const { selectedIds, onToggle } = colDef.cellRendererParams || {};
  const id = data._id;
  const checked = selectedIds?.has(id) ?? false;
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', height: '100%', paddingLeft: 8 }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle?.(id)}
        style={{ cursor: 'pointer', margin: 0 }}
      />
    </div>
  );
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
  const [baseColumnDefs, setBaseColumnDefs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Debounced search — avoid hammering server on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState(quickFilter);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(quickFilter), 300);
    return () => clearTimeout(timer);
  }, [quickFilter]);

  // Reset to page 0 and clear selection when filters change
  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
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
        setBaseColumnDefs(cols);
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

  const onToggle = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(async () => {
    if (!diffId) return;
    try {
      const { ids } = await fetchDiffItemIds(diffId, {
        changeType: changeType || undefined,
        search: debouncedSearch || undefined,
      });
      setSelectedIds(new Set(ids));
    } catch (err) {
      console.error('Failed to select all:', err);
    }
  }, [diffId, changeType, debouncedSearch]);

  const handleDeselectAll = useCallback(() => setSelectedIds(new Set()), []);

  const checkboxCol = useMemo(
    () => ({
      field: '_select',
      headerName: '',
      width: 44,
      suppressSort: true,
      pinned: 'left',
      cellRenderer: CheckboxCellRenderer,
      cellRendererParams: { selectedIds, onToggle },
    }),
    [selectedIds, onToggle]
  );

  const columnDefs = useMemo(
    () => [checkboxCol, ...baseColumnDefs],
    [checkboxCol, baseColumnDefs]
  );

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

  const downloadBlob = useCallback((blob, filename) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }, []);

  const handleExportAll = useCallback(async () => {
    if (!diffId) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportDiffCsv(diffId, {
        changeType: changeType || undefined,
        search: debouncedSearch || undefined,
      });
      downloadBlob(blob, filename);
    } catch (err) {
      console.error('CSV export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [diffId, changeType, debouncedSearch, downloadBlob]);

  const handleExportSelected = useCallback(async () => {
    if (!diffId || selectedIds.size === 0) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportDiffCsv(diffId, { ids: Array.from(selectedIds) });
      downloadBlob(blob, filename);
    } catch (err) {
      console.error('CSV export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [diffId, selectedIds, downloadBlob]);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>
              {total.toLocaleString()} total items
              {selectedIds.size > 0 && (
                <span style={{ color: '#58a6ff', marginLeft: 4 }}>({selectedIds.size.toLocaleString()} selected)</span>
              )}
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
              onClick={handleSelectAll}
              disabled={loading || total === 0}
              style={exportBtnStyle}
              title="Select all matching rows across pages"
            >
              Select all {total.toLocaleString()}
            </button>
            <button
              onClick={handleDeselectAll}
              disabled={selectedIds.size === 0}
              style={exportBtnStyle}
              title="Clear selection"
            >
              Deselect all
            </button>
            {selectedIds.size > 0 ? (
              <button
                onClick={handleExportSelected}
                disabled={exporting}
                style={exportBtnStyle}
                title="Export selected rows as CSV"
              >
                {exporting ? 'Exporting…' : `⬇ Export selected (${selectedIds.size.toLocaleString()})`}
              </button>
            ) : (
              <button
                onClick={handleExportAll}
                disabled={exporting || total === 0}
                style={exportBtnStyle}
                title="Export all matching rows as CSV"
              >
                {exporting ? 'Exporting…' : '⬇ Export all'}
              </button>
            )}
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
