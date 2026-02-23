import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import SummaryCards from '../components/SummaryCards.jsx';
import { ChangeDistributionChart, TrendChart } from '../components/DiffChart.jsx';
import DatePicker from '../components/DatePicker.jsx';
import {
  fetchDates,
  fetchSummary,
  fetchTrend,
  fetchDiffs,
  fetchDatasets,
  fetchPopulation,
  fetchVulnerabilityDistribution,
} from '../api/client.js';

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
  const [population, setPopulation] = useState([]);
  const [vulnerabilityDistribution, setVulnerabilityDistribution] = useState({ criticality: [], status: [] });
  const [filteredTrendData, setFilteredTrendData] = useState([]);
  const [filteredTrendLoading, setFilteredTrendLoading] = useState(false);
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
        const vulnDistributionPromise = category === 'vulnerability'
          ? fetchVulnerabilityDistribution(selectedDate, category, { signal: ac.signal }).catch(() => ({ criticality: [], status: [] }))
          : Promise.resolve({ criticality: [], status: [] });
        const [summaryResult, trendData, diffList, populationData, vulnDistribution] = await Promise.all([
          fetchSummary(selectedDate, category, { signal: ac.signal }),
          fetchTrend(30, null, category, { signal: ac.signal }),
          fetchDiffs(null, 90, category, { signal: ac.signal }),
          fetchPopulation(90, null, category).catch(() => []),
          vulnDistributionPromise,
        ]);
        if (cancelled) return;
        setSummary(summaryResult.data || []);
        setTrend(trendData);
        setDiffs(diffList);
        setPopulation(populationData || []);
        setVulnerabilityDistribution(vulnDistribution || { criticality: [], status: [] });
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setError(err.message);
      }
    }
    loadDate();
    return () => { cancelled = true; ac.abort(); };
  }, [selectedDate, category]);

  // When dataset filter is applied, fetch trend per selected dataset and merge by date
  useEffect(() => {
    if (selectedDatasetIds.size === 0) {
      setFilteredTrendData([]);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const ids = [...selectedDatasetIds];
    async function loadFilteredTrend() {
      setFilteredTrendLoading(true);
      try {
        const results = await Promise.all(
          ids.map((id) => fetchTrend(30, id, category, { signal: ac.signal }))
        );
        if (cancelled) return;
        const byDate = new Map();
        for (const arr of results) {
          for (const row of arr) {
            const d = row.to_date;
            if (!byDate.has(d)) {
              byDate.set(d, {
                to_date: d,
                added_count: 0,
                removed_count: 0,
                modified_count: 0,
                unchanged_count: 0,
              });
            }
            const m = byDate.get(d);
            m.added_count += row.added_count || 0;
            m.removed_count += row.removed_count || 0;
            m.modified_count += row.modified_count || 0;
            m.unchanged_count += row.unchanged_count || 0;
          }
        }
        const merged = [...byDate.values()].sort((a, b) =>
          a.to_date.localeCompare(b.to_date)
        );
        setFilteredTrendData(merged);
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setError(err.message);
      } finally {
        if (!cancelled) setFilteredTrendLoading(false);
      }
    }
    loadFilteredTrend();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [selectedDatasetIds, category]);

  const hasFilter = selectedDatasetIds.size > 0;

  const populationForDate = useMemo(() => {
    if (!selectedDate) return [];
    return population.filter((row) => {
      if (row.fetched_date !== selectedDate) return false;
      return hasFilter ? selectedDatasetIds.has(row.dataset_id) : true;
    });
  }, [population, selectedDate, hasFilter, selectedDatasetIds]);

  const coverageStats = useMemo(() => {
    const comparableRows = populationForDate.filter((row) => row.api_total != null);
    const expectedTotal = comparableRows.reduce((sum, row) => sum + (row.api_total || 0), 0);
    const receivedTotal = comparableRows.reduce((sum, row) => sum + (row.row_count || 0), 0);
    const pct = expectedTotal > 0 ? (receivedTotal / expectedTotal) * 100 : null;
    return {
      expectedTotal,
      receivedTotal,
      pct,
      comparableCount: comparableRows.length,
      totalCount: populationForDate.length,
      datasets: comparableRows
        .map((row) => {
          const expected = row.api_total || 0;
          const received = row.row_count || 0;
          const rowPct = expected > 0 ? (received / expected) * 100 : 0;
          return {
            dataset_name: row.dataset_name,
            expected,
            received,
            gap: received - expected,
            pct: rowPct,
          };
        })
        .sort((a, b) => a.pct - b.pct),
    };
  }, [populationForDate]);

  const coverageTrend = useMemo(() => {
    const byDate = new Map();
    for (const row of population) {
      if (hasFilter && !selectedDatasetIds.has(row.dataset_id)) continue;
      if (row.api_total == null) continue;
      if (!byDate.has(row.fetched_date)) {
        byDate.set(row.fetched_date, { date: row.fetched_date, expected: 0, received: 0 });
      }
      const d = byDate.get(row.fetched_date);
      d.expected += row.api_total || 0;
      d.received += row.row_count || 0;
    }
    return [...byDate.values()]
      .map((d) => ({
        date: d.date,
        pct: d.expected > 0 ? (d.received / d.expected) * 100 : null,
      }))
      .filter((d) => d.pct != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7);
  }, [population, hasFilter, selectedDatasetIds]);

  const criticalityDistribution = useMemo(() => {
    if (category !== 'vulnerability') return [];
    return aggregateDistribution(
      vulnerabilityDistribution.criticality,
      hasFilter,
      selectedDatasetIds,
      ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'],
      true
    );
  }, [category, vulnerabilityDistribution, hasFilter, selectedDatasetIds]);

  const statusDistribution = useMemo(() => {
    if (category !== 'vulnerability') return [];
    return aggregateDistribution(
      vulnerabilityDistribution.status,
      hasFilter,
      selectedDatasetIds,
      ['detected', 'in_progress', 'resolved', 'reopened', 'unknown'],
      false
    );
  }, [category, vulnerabilityDistribution, hasFilter, selectedDatasetIds]);

  // Filter summary to selected datasets (for cards + distribution chart)
  const filteredSummary = useMemo(() => {
    if (!hasFilter) return summary;
    const selectedNames = new Set(
      datasets.filter(d => selectedDatasetIds.has(d.id)).map(d => d.name)
    );
    return summary.filter(s => selectedNames.has(s.dataset_name));
  }, [summary, selectedDatasetIds, datasets, hasFilter]);

  // Trend for chart: when filtered, use per-dataset fetched & merged data; otherwise use full trend
  const trendForChart = hasFilter ? filteredTrendData : trend;

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

      {category === 'vulnerability' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
          <div style={panelStyle}>
            <h3 style={panelTitle}>Criticality Distribution</h3>
            <DistributionBars
              rows={criticalityDistribution}
              colorByLabel={criticalityColors}
              formatLabel={(label) => label}
              emptyText="No criticality data for this date."
            />
          </div>
          <div style={panelStyle}>
            <h3 style={panelTitle}>Status Distribution</h3>
            <DistributionBars
              rows={statusDistribution}
              colorByLabel={statusColors}
              formatLabel={(label) => label.replaceAll('_', ' ')}
              emptyText="No status data for this date."
            />
          </div>
        </div>
      )}

      {/* Expected vs received population quality */}
      <div style={{ ...panelStyle, marginTop: '1.5rem' }}>
        <h3 style={panelTitle}>Expected vs Received Records</h3>
        {populationForDate.length === 0 ? (
          <div style={{ color: '#8b949e', padding: '0.75rem 0' }}>
            No population snapshot data for {selectedDate}.
          </div>
        ) : coverageStats.comparableCount === 0 ? (
          <div style={{ color: '#8b949e', padding: '0.75rem 0' }}>
            Snapshot data exists, but API expected totals are missing for this date.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <div style={metricChip}>
                <div style={metricLabel}>Received</div>
                <div style={metricValue}>{coverageStats.receivedTotal.toLocaleString()}</div>
              </div>
              <div style={metricChip}>
                <div style={metricLabel}>Expected</div>
                <div style={metricValue}>{coverageStats.expectedTotal.toLocaleString()}</div>
              </div>
              <div style={metricChip}>
                <div style={metricLabel}>Coverage</div>
                <div style={metricValue}>{coverageStats.pct.toFixed(1)}%</div>
              </div>
              <div style={{ ...metricChip, minWidth: 220 }}>
                <div style={metricLabel}>7-Day Coverage Trend</div>
                <CoverageSparkline data={coverageTrend} />
              </div>
            </div>

            <div style={coverageTrack}>
              <div
                style={{
                  ...coverageFill,
                  width: `${Math.max(0, Math.min(100, coverageStats.pct))}%`,
                  background: coverageStats.pct >= 98 ? '#3fb950' : coverageStats.pct >= 90 ? '#e3b341' : '#f85149',
                }}
              />
            </div>

            <div style={{ color: '#8b949e', fontSize: '0.8rem', marginTop: '0.5rem', marginBottom: '0.75rem' }}>
              Using {coverageStats.comparableCount}/{coverageStats.totalCount} datasets with API totals.
            </div>

            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Dataset</th>
                    <th style={thStyle}>Received</th>
                    <th style={thStyle}>Expected</th>
                    <th style={thStyle}>Gap</th>
                    <th style={thStyle}>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageStats.datasets.map((row) => (
                    <tr key={row.dataset_name} style={trStyle}>
                      <td style={tdStyle}>{row.dataset_name}</td>
                      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{row.received.toLocaleString()}</td>
                      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{row.expected.toLocaleString()}</td>
                      <td
                        style={{
                          ...tdStyle,
                          color: row.gap < 0 ? '#f85149' : '#3fb950',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {row.gap >= 0 ? '+' : ''}
                        {row.gap.toLocaleString()}
                      </td>
                      <td style={tdStyle}>
                        <div style={rowCoverageTrack}>
                          <div
                            style={{
                              ...rowCoverageFill,
                              width: `${Math.max(0, Math.min(100, row.pct))}%`,
                              background: row.pct >= 98 ? '#3fb950' : row.pct >= 90 ? '#e3b341' : '#f85149',
                            }}
                          />
                        </div>
                        <div style={{ color: '#8b949e', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                          {row.pct.toFixed(1)}%
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

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
          {filteredTrendLoading ? (
            <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>Loading trend...</div>
          ) : trendForChart.length > 0 ? (
            <TrendChart trend={trendForChart} />
          ) : (
            <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>Not enough data for trend</div>
          )}
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

const metricChip = {
  background: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: '0.5rem 0.75rem',
  minWidth: 130,
};

const metricLabel = {
  color: '#8b949e',
  fontSize: '0.75rem',
  marginBottom: '0.2rem',
};

const metricValue = {
  color: '#e1e4e8',
  fontSize: '1rem',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const coverageTrack = {
  width: '100%',
  height: 10,
  background: '#21262d',
  borderRadius: 999,
  overflow: 'hidden',
  border: '1px solid #30363d',
};

const coverageFill = {
  height: '100%',
  transition: 'width 0.2s ease',
};

const rowCoverageTrack = {
  width: '100%',
  maxWidth: 180,
  height: 8,
  background: '#21262d',
  borderRadius: 999,
  overflow: 'hidden',
  border: '1px solid #30363d',
};

const rowCoverageFill = {
  height: '100%',
  transition: 'width 0.2s ease',
};

function CoverageSparkline({ data }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#8b949e', fontSize: '0.75rem' }}>No trend data</div>;
  }

  const width = 170;
  const height = 36;
  const padding = 3;
  const values = data.map((d) => d.pct);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = Math.max(0.0001, maxV - minV);

  const points = values.map((v, i) => {
    const x = padding + (i * (width - padding * 2)) / Math.max(1, values.length - 1);
    const y = padding + ((maxV - v) / span) * (height - padding * 2);
    return [x, y];
  });

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
  const last = values[values.length - 1];
  const color = last >= 98 ? '#3fb950' : last >= 90 ? '#e3b341' : '#f85149';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Coverage sparkline">
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="#30363d" strokeWidth="1" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ color, fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>
        {last.toFixed(1)}%
      </div>
    </div>
  );
}

function aggregateDistribution(rows, hasFilter, selectedDatasetIds, preferredOrder, upperCaseLabel) {
  if (!rows || rows.length === 0) return [];
  const totals = new Map();
  for (const row of rows) {
    if (hasFilter && !selectedDatasetIds.has(row.dataset_id)) continue;
    const raw = typeof row.label === 'string' ? row.label : 'unknown';
    const normalized = upperCaseLabel ? raw.toUpperCase() : raw.toLowerCase();
    totals.set(normalized, (totals.get(normalized) || 0) + (row.count || 0));
  }

  const arr = [...totals.entries()].map(([label, count]) => ({ label, count }));
  const orderRank = new Map(preferredOrder.map((label, idx) => [label, idx]));
  arr.sort((a, b) => {
    const aRank = orderRank.has(a.label) ? orderRank.get(a.label) : Number.MAX_SAFE_INTEGER;
    const bRank = orderRank.has(b.label) ? orderRank.get(b.label) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return b.count - a.count;
  });
  return arr;
}

function DistributionBars({ rows, colorByLabel, formatLabel, emptyText }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: '#8b949e', padding: '1rem 0.25rem' }}>{emptyText}</div>;
  }

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {rows.map((row) => {
        const pct = total > 0 ? (row.count / total) * 100 : 0;
        const color = colorByLabel[row.label] || '#58a6ff';
        return (
          <div key={row.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
              <div style={{ color: '#e1e4e8', fontSize: '0.82rem', textTransform: 'capitalize' }}>
                {formatLabel(row.label)}
              </div>
              <div style={{ color: '#8b949e', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
                {row.count.toLocaleString()} ({pct.toFixed(1)}%)
              </div>
            </div>
            <div style={distributionTrack}>
              <div
                style={{
                  ...distributionFill,
                  width: `${Math.max(0, Math.min(100, pct))}%`,
                  background: color,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const criticalityColors = {
  CRITICAL: '#f85149',
  HIGH: '#ff7b72',
  MEDIUM: '#e3b341',
  LOW: '#3fb950',
  INFO: '#58a6ff',
  UNKNOWN: '#8b949e',
};

const statusColors = {
  detected: '#f85149',
  in_progress: '#e3b341',
  resolved: '#3fb950',
  reopened: '#ff7b72',
  unknown: '#8b949e',
};

const distributionTrack = {
  width: '100%',
  height: 10,
  background: '#21262d',
  borderRadius: 999,
  border: '1px solid #30363d',
  overflow: 'hidden',
};

const distributionFill = {
  height: '100%',
  transition: 'width 0.2s ease',
};
