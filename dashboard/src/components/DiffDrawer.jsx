import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

const INLINE_MAX_LEN = 150;
const BADGE_COLORS = {
  added: { bg: '#0d1f0d', color: '#3fb950', border: '#238636' },
  removed: { bg: '#1f0d0d', color: '#f85149', border: '#da3633' },
  modified: { bg: '#1f1a0d', color: '#e3b341', border: '#d29922' },
};

function formatValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/** Check if array is field-value format: [{field:"x", value?: "y"}, ...] */
function isFieldValueArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  return first && typeof first === 'object' && 'field' in first;
}

/** Flatten field-value array to { fieldName: value } */
function fieldValueArrayToObject(arr) {
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (const item of arr) {
    if (item && typeof item === 'object' && 'field' in item) {
      const key = item.field;
      const val = 'value' in item ? item.value : null;
      out[key] = val;
    }
  }
  return out;
}

/**
 * Get nested changes for modified field. Returns [{path, old, new}, ...].
 * Handles: field-value arrays (attributes), plain objects, primitives.
 */
function getNestedChanges(oldVal, newVal, prefix = '') {
  const changes = [];

  // Both primitives or one is primitive: treat as single change
  if (typeof oldVal !== 'object' || oldVal === null || typeof newVal !== 'object' || newVal === null) {
    if (oldVal !== newVal) {
      changes.push({ path: prefix, old: oldVal, new: newVal });
    }
    return changes;
  }

  // Both arrays: check for field-value format
  if (Array.isArray(oldVal) && Array.isArray(newVal) && isFieldValueArray(oldVal) && isFieldValueArray(newVal)) {
    const oldObj = fieldValueArrayToObject(oldVal);
    const newObj = fieldValueArrayToObject(newVal);
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    for (const k of allKeys) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in oldObj)) {
        changes.push({ path: p, old: undefined, new: newObj[k] });
      } else if (!(k in newObj)) {
        changes.push({ path: p, old: oldObj[k], new: undefined });
      } else if (oldObj[k] !== newObj[k]) {
        changes.push({ path: p, old: oldObj[k], new: newObj[k] });
      }
    }
    return changes;
  }

  // Both plain objects (not arrays): recursive diff
  if (!Array.isArray(oldVal) && !Array.isArray(newVal)) {
    const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    for (const k of allKeys) {
      const p = prefix ? `${prefix}.${k}` : k;
      const o = oldVal[k];
      const n = newVal[k];
      // If both are objects, recurse
      if (
        o !== null &&
        o !== undefined &&
        n !== null &&
        n !== undefined &&
        typeof o === 'object' &&
        typeof n === 'object' &&
        !Array.isArray(o) &&
        !Array.isArray(n)
      ) {
        changes.push(...getNestedChanges(o, n, p));
      } else if (o !== n) {
        changes.push({ path: p, old: o, new: n });
      }
    }
    return changes;
  }

  // Other (e.g. array vs object): treat as single change
  if (formatValue(oldVal) !== formatValue(newVal)) {
    changes.push({ path: prefix, old: oldVal, new: newVal });
  }
  return changes;
}

function formatForDisplay(val) {
  const str = formatValue(val);
  if (str.length <= INLINE_MAX_LEN) {
    return { inline: true, str };
  }
  return { inline: false, str };
}

function ValueDisplay({ value, color }) {
  const { inline, str } = formatForDisplay(value);
  if (inline) {
    return <span style={{ color: color || '#e1e4e8', wordBreak: 'break-word' }}>{str || '(empty)'}</span>;
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: '0.5rem',
        background: '#0d1117',
        border: '1px solid #30363d',
        borderRadius: 4,
        fontSize: '0.75rem',
        color: color || '#e1e4e8',
        maxHeight: 180,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {str}
    </pre>
  );
}

export default function DiffDrawer({ open, onClose, row, fromDate, toDate }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    if (open) {
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
  }, [open, onClose]);

  if (!open) return null;

  const changeType = row?._changeType;
  const rowKey = row?._rowKey;
  const oldData = row?._oldData || {};
  const newData = row?._newData || {};
  const changedFields = row?._changedFields || [];

  const badgeColors = BADGE_COLORS[changeType] || BADGE_COLORS.modified;

  const dataKeys = (changeType === 'added' ? Object.keys(newData) : Object.keys(oldData)).filter(
    (k) => !k.startsWith('_')
  );

  const content = (
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 100000,
          animation: 'diff-drawer-fade 0.2s ease-out',
        }}
      />
      {/* Drawer panel — z-index above AG Grid overlays (~99999) */}
      <div
        role="dialog"
        aria-label="Diff details"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '50vw',
          maxWidth: '90vw',
          background: '#161b22',
          borderLeft: '1px solid #30363d',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
          zIndex: 100001,
          display: 'flex',
          flexDirection: 'column',
          animation: 'diff-drawer-slide 0.2s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid #30363d',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
            <span
              style={{
                background: badgeColors.bg,
                color: badgeColors.color,
                border: `1px solid ${badgeColors.border}`,
                borderRadius: 12,
                padding: '2px 10px',
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                flexShrink: 0,
              }}
            >
              {changeType || '—'}
            </span>
            <code
              style={{
                fontSize: '0.8rem',
                color: '#8b949e',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={rowKey}
            >
              {rowKey}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8b949e',
              cursor: 'pointer',
              fontSize: '1.25rem',
              padding: '0.25rem',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem' }}>
          {changeType === 'modified' && (() => {
            const dateRange = fromDate && toDate ? `${fromDate} → ${toDate}` : (toDate || fromDate || '—');
            const rows = [];
            for (const field of changedFields) {
              const oldVal = oldData[field];
              const newVal = newData[field];
              const nested = getNestedChanges(oldVal, newVal, field);
              if (nested.length > 1 || (nested.length === 1 && nested[0].path !== field)) {
                // Nested changes: show each sub-field
                for (const { path, old: o, new: n } of nested) {
                  rows.push(
                    <tr key={path}>
                      <td style={{ ...tdStyle, fontSize: '0.8rem', color: '#8b949e', whiteSpace: 'nowrap' }}>{dateRange}</td>
                      <td style={tdStyle}>
                        <code style={{ fontSize: '0.8rem', color: '#58a6ff' }}>{path}</code>
                      </td>
                      <td style={{ ...tdStyle, verticalAlign: 'top' }}>
                        <ValueDisplay value={o} color="#f85149" />
                      </td>
                      <td style={{ ...tdStyle, verticalAlign: 'top' }}>
                        <ValueDisplay value={n} color="#3fb950" />
                      </td>
                    </tr>
                  );
                }
              } else {
                // Single top-level change (primitive or non-diffable)
                rows.push(
                  <tr key={field}>
                    <td style={{ ...tdStyle, fontSize: '0.8rem', color: '#8b949e', whiteSpace: 'nowrap' }}>{dateRange}</td>
                    <td style={tdStyle}>
                      <code style={{ fontSize: '0.8rem', color: '#58a6ff' }}>{field}</code>
                    </td>
                    <td style={{ ...tdStyle, verticalAlign: 'top' }}>
                      <ValueDisplay value={oldVal} color="#f85149" />
                    </td>
                    <td style={{ ...tdStyle, verticalAlign: 'top' }}>
                      <ValueDisplay value={newVal} color="#3fb950" />
                    </td>
                  </tr>
                );
              }
            }
            return (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 120 }}>Date</th>
                    <th style={{ ...thStyle, width: 140 }}>Field</th>
                    <th style={{ ...thStyle, color: '#f85149' }}>Old</th>
                    <th style={{ ...thStyle, color: '#3fb950' }}>New</th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            );
          })()}

          {changeType === 'added' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {dataKeys.map((key) => (
                <div key={key}>
                  <div style={{ fontSize: '0.75rem', color: '#8b949e', marginBottom: '0.25rem' }}>
                    <code style={{ color: '#58a6ff' }}>{key}</code>
                  </div>
                  <ValueDisplay value={newData[key]} color="#3fb950" />
                </div>
              ))}
              {dataKeys.length === 0 && (
                <div style={{ color: '#8b949e', fontSize: '0.85rem' }}>No fields</div>
              )}
            </div>
          )}

          {changeType === 'removed' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {dataKeys.map((key) => (
                <div key={key}>
                  <div style={{ fontSize: '0.75rem', color: '#8b949e', marginBottom: '0.25rem' }}>
                    <code style={{ color: '#58a6ff' }}>{key}</code>
                  </div>
                  <ValueDisplay value={oldData[key]} color="#f85149" />
                </div>
              ))}
              {dataKeys.length === 0 && (
                <div style={{ color: '#8b949e', fontSize: '0.85rem' }}>No fields</div>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes diff-drawer-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes diff-drawer-slide {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </>
  );

  return typeof document !== 'undefined'
    ? createPortal(content, document.body, 'diff-drawer-portal')
    : null;
}

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #30363d',
  color: '#8b949e',
  fontWeight: 600,
  fontSize: '0.75rem',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #21262d',
  color: '#e1e4e8',
};
