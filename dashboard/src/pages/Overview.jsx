import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import SummaryCards from '../components/SummaryCards.jsx';
import { ChangeDistributionChart, TrendChart } from '../components/DiffChart.jsx';
import DatePicker from '../components/DatePicker.jsx';
import { fetchDates, fetchSummary, fetchTrend, fetchDiffs, fetchDatasets } from '../api/client.js';

const TITLES = {
  platform: 'Platform Overview',
  vulnerability: 'Vulnerability Overview',
};

export default function Overview({ category }) {
  const navigate = useNavigate();
  const basePath = category === 'vulnerability' ? '/vulns' : '/platform';

  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [summary, setSummary] = useState([]);
  const [trend, setTrend] = useState([]);
  const [diffs, setDiffs] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Dataset filter — empty Set means "all", otherwise the checked dataset IDs
  const [selectedDatasetIds, setSelectedDatasetIds] = useState(new Set());

  // Reset filter when category changes
  useEffect(() => {
    setSelectedDatasetIds(new Set());
  }, [category]);

  // Load initial data (scoped to category)
  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [dateList, ds] = await Promise.all([
          fetchDates(category, { signal: ac.signal }),
          fetchDatasets(category, { signal: ac.signal }),
        ]);
        if (cancelled) return;
        setDates(dateList);
        setDatasets(ds);
        if (dateList.length > 0) {
          setSelectedDate(dateList[0]);
        } else {
          setSelectedDate(null);
          setSummary([]);
          setTrend([]);
          setDiffs([]);
        }
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; ac.abort(); };
  }, [category]);

  // Load data for selected date (scoped to category)
  useEffect(() => {
    if (!selectedDate) return;
    const ac = new AbortController();
    let cancelled = false;
    async function loadDate() {
      try {
        const [summaryResult, trendData, diffList] = await Promise.all([
          fetchSummary(selectedDate, category, { signal: ac.signal }),
          fetchTrend(30, null, category, { signal: ac.signal }),
          fetchDiffs(null, 90, category, { signal: ac.signal }),
        ]);
        if (cancelled) return;
        setSummary(summaryResult.data || []);
        setTrend(trendData);
        setDiffs(diffList);
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setError(err.message);
      }
    }
    loadDate();
    return () => { cancelled = true; ac.abort(); };
  }, [selectedDate, category]);

  const hasFilter = selectedDatasetIds.size > 0;

  // Filter summary to selected datasets (for cards + distribution chart)
  const filteredSummary = useMemo(() => {
    if (!hasFilter) return summary;
    const selectedNames = new Set(
      datasets.filter(d => selectedDatasetIds.has(d.id)).map(d => d.name)
    );
    return summary.filter(s => selectedNames.has(s.dataset_name));
  }, [summary, selectedDatasetIds, datasets, hasFilter]);

  // Filter trend to selected datasets
  const filteredTrend = useMemo(() => {
    if (!hasFilter) return trend;
    const selectedNames = new Set(
      datasets.filter(d => selectedDatasetIds.has(d.id)).map(d => d.name)
    );
    // Trend items have a dataset_name field — aggregate only the selected ones
    // If trend entries don't carry dataset_name, return as-is (the API already aggregates)
    if (trend.length > 0 && trend[0].dataset_name) {
      return trend.filter(t => selectedNames.has(t.dataset_name));
    }
    return trend;
  }, [trend, selectedDatasetIds, datasets, hasFilter]);

  // Build display label for active filter
  const totalCount = useMemo(() => {
    return filteredSummary.reduce((sum, s) => {
      return sum + (s.added_count || 0) + (s.removed_count || 0) + (s.modified_count || 0) + (s.unchanged_count || 0);
    }, 0);
  }, [filteredSummary]);

  const filterLabel = useMemo(() => {
    if (!hasFilter) return null;
    const names = datasets
      .filter(d => selectedDatasetIds.has(d.id))
      .map(d => d.name);
    if (names.length <= 2) return names.join(', ');
    return `${names.length} datasets`;
  }, [selectedDatasetIds, datasets, hasFilter]);

  function toggleDataset(dsId) {
    setSelectedDatasetIds(prev => {
      const next = new Set(prev);
      if (next.has(dsId)) {
        next.delete(dsId);
      } else {
        next.add(dsId);
      }
      return next;
    });
  }

  function clearFilter() {
    setSelectedDatasetIds(new Set());
  }

  if (loading) {
    return <div style={{ color: '#8b949e', padding: '2rem' }}>Loading...</div>;
  }

  if (error) {
    return (
      <div style={{ color: '#f85149', padding: '2rem' }}>
        <strong>Error:</strong> {error}
      </div>
    );
  }

  if (dates.length === 0) {
    return (
      <div style={emptyState}>
        <h2 style={{ color: '#e1e4e8', marginBottom: '0.5rem' }}>No Data Yet</h2>
        <p>Run a fetch and diff first:</p>
        <pre style={codeBlock}>node src/cli.mjs run</pre>
        <p style={{ marginTop: '0.5rem' }}>Then refresh this page.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header row with date picker */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <h2 style={{ color: '#e1e4e8', fontSize: '1.25rem', fontWeight: 600 }}>
          {TITLES[category] || 'Overview'}
          {filteredSummary.length > 0 && (
            <span style={{ color: '#58a6ff', fontWeight: 400, fontSize: '0.9rem', marginLeft: '0.75rem' }}>
              — {totalCount.toLocaleString()} total
            </span>
          )}
          {hasFilter && (
            <span style={{ color: '#58a6ff', fontWeight: 400, fontSize: '0.9rem', marginLeft: '0.75rem' }}>
              Filtered: {filterLabel}
              <button
                onClick={clearFilter}
                style={clearFilterBtn}
                title="Clear filter"
              >
                &times;
              </button>
            </span>
          )}
        </h2>
        <DatePicker dates={dates} selected={selectedDate} onChange={setSelectedDate} />
      </div>

      {/* Summary cards — filtered */}
      <SummaryCards summary={filteredSummary} />

      {/* Charts — filtered */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={panelStyle}>
          <h3 style={panelTitle}>Change Distribution by Dataset</h3>
          {filteredSummary.length > 0
            ? <ChangeDistributionChart summary={filteredSummary} />
            : <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>No data for this date</div>
          }
        </div>
        <div style={panelStyle}>
          <h3 style={panelTitle}>
            Trend (Last 30 Days)
            {hasFilter && (
              <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                — {filterLabel}
              </span>
            )}
          </h3>
          {filteredTrend.length > 0
            ? <TrendChart trend={filteredTrend} />
            : <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>Not enough data for trend</div>
          }
        </div>
      </div>

      {/* Diff list for selected date */}
      <div style={{ ...panelStyle, marginTop: '1.5rem' }}>
        <h3 style={panelTitle}>Diffs for {selectedDate}</h3>
        {summary.length > 0 ? (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 40 }}></th>
                <th style={thStyle}>Dataset</th>
                <th style={thStyle}>From</th>
                <th style={thStyle}>To</th>
                <th style={{ ...thStyle, color: '#3fb950' }}>Added</th>
                <th style={{ ...thStyle, color: '#f85149' }}>Removed</th>
                <th style={{ ...thStyle, color: '#e3b341' }}>Modified</th>
                <th style={{ ...thStyle, color: '#8b949e' }}>Unchanged</th>
                <th style={{ ...thStyle, color: '#58a6ff' }}>Total</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => {
                const dsId = datasets.find(d => d.name === s.dataset_name)?.id;
                const isSelected = dsId != null && selectedDatasetIds.has(dsId);
                return (
                  <tr
                    key={s.diff_id}
                    style={{
                      ...trStyle,
                      background: isSelected ? 'rgba(88, 166, 255, 0.08)' : undefined,
                    }}
                  >
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleDataset(dsId)}
                        style={checkboxStyle}
                        title={isSelected ? 'Clear filter' : `Filter to ${s.dataset_name}`}
                      />
                    </td>
                    <td
                      style={{ ...tdStyle, cursor: 'pointer', fontWeight: isSelected ? 600 : 400 }}
                      onClick={() => toggleDataset(dsId)}
                    >
                      {s.dataset_name}
                    </td>
                    <td style={tdStyle}>{s.from_date}</td>
                    <td style={tdStyle}>{s.to_date}</td>
                    <td style={{ ...tdStyle, color: '#3fb950', fontVariantNumeric: 'tabular-nums' }}>+{s.added_count}</td>
                    <td style={{ ...tdStyle, color: '#f85149', fontVariantNumeric: 'tabular-nums' }}>-{s.removed_count}</td>
                    <td style={{ ...tdStyle, color: '#e3b341', fontVariantNumeric: 'tabular-nums' }}>~{s.modified_count}</td>
                    <td style={{ ...tdStyle, color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>{s.unchanged_count}</td>
                    <td style={{ ...tdStyle, color: '#58a6ff', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {(s.added_count + s.removed_count + s.modified_count + s.unchanged_count).toLocaleString()}
                    </td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => navigate(`${basePath}/diff/${s.diff_id}`)}
                        style={viewBtnStyle}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ color: '#8b949e', padding: '1rem' }}>No diffs for this date.</div>
        )}
      </div>
    </div>
  );
}

const emptyState = {
  color: '#8b949e',
  textAlign: 'center',
  padding: '4rem 2rem',
};

const codeBlock = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.75rem 1rem',
  fontFamily: 'SF Mono, Monaco, Consolas, monospace',
  fontSize: '0.85rem',
  display: 'inline-block',
  marginTop: '0.5rem',
  color: '#e1e4e8',
};

const panelStyle = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: '1rem 1.25rem',
};

const panelTitle = {
  color: '#e1e4e8',
  fontSize: '0.95rem',
  fontWeight: 600,
  marginBottom: '0.75rem',
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #30363d',
  color: '#8b949e',
  fontWeight: 600,
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #21262d',
  color: '#e1e4e8',
};

const trStyle = {
  transition: 'background 0.1s',
};

const viewBtnStyle = {
  background: '#21262d',
  color: '#58a6ff',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
  fontWeight: 500,
};

const clearFilterBtn = {
  background: 'none',
  border: 'none',
  color: '#8b949e',
  cursor: 'pointer',
  fontSize: '1rem',
  marginLeft: '0.35rem',
  padding: '0 0.2rem',
  lineHeight: 1,
  verticalAlign: 'middle',
};

const checkboxStyle = {
  cursor: 'pointer',
  width: 15,
  height: 15,
  accentColor: '#58a6ff',
};
