import React, { useMemo, useRef, useCallback } from 'react';
import { AllCommunityModule, themeQuartz, colorSchemeDarkBlue } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';

const modules = [AllCommunityModule];
const darkTheme = themeQuartz.withPart(colorSchemeDarkBlue);

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

  // For added rows: green text
  if (changeType === 'added') {
    return <span style={{ color: '#3fb950' }}>{formatValue(value)}</span>;
  }

  // For removed rows: red text
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
 * DiffGrid - AG Grid table for displaying diff items with highlighting.
 */
export default function DiffGrid({ items, quickFilter }) {
  const gridRef = useRef(null);

  // Build column definitions dynamically from the data
  const { columnDefs, rowData } = useMemo(() => {
    if (!items || items.length === 0) {
      return { columnDefs: [], rowData: [] };
    }

    // Collect all field names from the data
    const fieldSet = new Set();
    for (const item of items) {
      const data = item.new_data || item.old_data || {};
      Object.keys(data).forEach((k) => fieldSet.add(k));
    }

    const fields = Array.from(fieldSet);

    // Build columns
    const cols = [
      {
        field: '_changeType',
        headerName: 'Change',
        width: 120,
        pinned: 'left',
        cellRenderer: DiffCellRenderer,
        filter: true,
        sort: 'asc',
      },
      {
        field: '_rowKey',
        headerName: 'Row Key',
        width: 150,
        pinned: 'left',
        filter: true,
      },
      ...fields.map((f) => ({
        field: f,
        headerName: f,
        minWidth: 120,
        flex: 1,
        cellRenderer: DiffCellRenderer,
        filter: true,
        sortable: true,
        resizable: true,
      })),
    ];

    // Build row data
    const rows = items.map((item, idx) => {
      const current = item.new_data || item.old_data || {};
      return {
        _id: idx,
        _changeType: item.change_type,
        _rowKey: item.row_key,
        _changedFields: item.changed_fields || [],
        _oldData: item.old_data || {},
        _newData: item.new_data || {},
        ...current,
      };
    });

    return { columnDefs: cols, rowData: rows };
  }, [items]);

  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    minWidth: 80,
  }), []);

  const onGridReady = useCallback(() => {
    // Auto-size columns after data loads
  }, []);

  const getRowStyle = useCallback((params) => {
    if (!params.data) return {};
    switch (params.data._changeType) {
      case 'added':
        return { background: 'rgba(63, 185, 80, 0.05)' };
      case 'removed':
        return { background: 'rgba(248, 81, 73, 0.05)' };
      case 'modified':
        return { background: 'rgba(227, 179, 65, 0.03)' };
      default:
        return {};
    }
  }, []);

  if (!items || items.length === 0) {
    return (
      <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>
        No diff items to display. Select a diff from the overview or change filters.
      </div>
    );
  }

  return (
    <AgGridProvider modules={modules}>
      <div style={{ width: '100%', height: 'calc(100vh - 300px)', minHeight: 400 }}>
        <AgGridReact
          ref={gridRef}
          theme={darkTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          onGridReady={onGridReady}
          getRowStyle={getRowStyle}
          quickFilterText={quickFilter}
          animateRows={false}
          pagination={true}
          paginationPageSize={100}
          paginationPageSizeSelector={[50, 100, 250, 500]}
          enableCellTextSelection={true}
          suppressCellFocus={true}
          getRowId={(params) => String(params.data._id)}
        />
      </div>
    </AgGridProvider>
  );
}
