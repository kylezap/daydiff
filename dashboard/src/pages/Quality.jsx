import React, { useState, useEffect } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceDot,
} from 'recharts';
import {
  fetchPopulation,
  fetchFlapping,
  fetchFieldStability,
  fetchSourceSegments,
  fetchReferential,
  fetchAssertions,
  fetchAssertionHistory,
  fetchAssertionSummary,
  fetchDatasets,
} from '../api/client.js';

// ─── Main Page ───────────────────────────────────────────────────

export default function Quality() {
  const [category, setCategory] = useState('platform'); // 'platform' | 'vulnerability' | ''
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Panel data
  const [assertions, setAssertions] = useState([]);
  const [assertionSummary, setAssertionSummary] = useState([]);
  const [population, setPopulation] = useState([]);
  const [flapping, setFlapping] = useState([]);
  const [fieldStability, setFieldStability] = useState([]);
  const [sourceSegments, setSourceSegments] = useState([]);
  const [referential, setReferential] = useState([]);

  const catParam = category || undefined; // '' means all

  // Load datasets when category changes (scoped to platform/vuln when selected)
  useEffect(() => {
    fetchDatasets(catParam).then(setDatasets).catch(err => setError(err.message));
  }, [catParam]);

  // Reset dataset selection when category changes
  useEffect(() => {
    setSelectedDatasetId('');
  }, [category]);

  // Load all quality data (scoped by category)
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const dsId = selectedDatasetId || undefined;
        const [aRes, aSumRes, popRes, flapRes, fsRes, srcRes, refRes] = await Promise.all([
          fetchAssertions().catch(() => []),
          fetchAssertionSummary(30).catch(() => []),
          fetchPopulation(30, dsId, catParam).catch(() => []),
          fetchFlapping(dsId, 7, catParam).catch(() => []),
          fetchFieldStability(dsId, 30, catParam).catch(() => []),
          fetchSourceSegments(dsId, undefined, catParam).catch(() => []),
          fetchReferential().catch(() => []),
        ]);
        setAssertions(aRes);
        setAssertionSummary(aSumRes);
        setPopulation(popRes);
        setFlapping(flapRes);
        setFieldStability(fsRes);
        setSourceSegments(srcRes);
        setReferential(refRes);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [selectedDatasetId, catParam]);

  if (error && !loading) {
    return (
      <div style={{ color: '#f85149', padding: '2rem' }}>
        <strong>Error:</strong> {error}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h2 style={headerStyle}>Data Quality</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={selectStyle}
            title="Filter quality data by dataset category"
          >
            <option value="platform">Platform</option>
            <option value="vulnerability">Vulnerabilities</option>
            <option value="">All</option>
          </select>
          <select
            value={selectedDatasetId}
            onChange={e => setSelectedDatasetId(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Datasets</option>
            {datasets.map(ds => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && <div style={{ color: '#8b949e', padding: '1rem' }}>Loading quality data...</div>}

      {/* 0. Assertion Summary */}
      <AssertionSummaryPanel data={assertionSummary} />

      {/* 1. Assertion Results Strip */}
      <AssertionStrip assertions={assertions} />

      {/* 2. Population Trend */}
      <PopulationPanel data={population} />

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        {/* 3. Flapping Records */}
        <FlappingPanel data={flapping} />

        {/* 4. Field Stability */}
        <FieldStabilityPanel data={fieldStability} />
      </div>

      {/* Bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        {/* 5. Source Segmentation */}
        <SourceSegmentPanel data={sourceSegments} />

        {/* 6. Referential Integrity */}
        <ReferentialPanel data={referential} />
      </div>
    </div>
  );
}

// ─── Panel Components ────────────────────────────────────────────

function AssertionSummaryPanel({ data }) {
  const chartData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.map(d => ({
      date: d.date,
      passed: d.passed,
      failed: d.failed,
    }));
  }, [data]);

  return (
    <div style={{ ...panelStyle, marginBottom: '1rem' }}>
      <h3 style={panelTitle}>Assertion Pass Rate <span style={subtitleStyle}>(last 30 days)</span></h3>
      {chartData.length === 0 ? (
        <div style={emptyText}>No assertion history yet. Run <code style={codeStyle}>node src/cli.mjs run</code> to generate.</div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="date" tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend />
            <Bar dataKey="passed" stackId="a" fill="#3fb950" name="Passed" radius={[0, 0, 4, 4]} />
            <Bar dataKey="failed" stackId="a" fill="#f85149" name="Failed" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function AssertionStrip({ assertions }) {
  if (!assertions || assertions.length === 0) {
    return (
      <div style={panelStyle}>
        <h3 style={panelTitle}>Assertion Results</h3>
        <div style={emptyText}>No assertion results yet. Run <code style={codeStyle}>node src/cli.mjs run</code> to generate.</div>
      </div>
    );
  }

  return (
    <div style={{ ...panelStyle, marginBottom: '1rem' }}>
      <h3 style={panelTitle}>Assertion Results</h3>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {assertions.map(a => (
          <AssertionCard key={`${a.assertion_id}-${a.id}`} assertion={a} />
        ))}
      </div>
    </div>
  );
}

function AssertionHistoryChart({ assertionId, days = 14 }) {
  const [data, setData] = useState([]);
  useEffect(() => {
    fetchAssertionHistory(assertionId, days)
      .then(setData)
      .catch(() => setData([]));
  }, [assertionId, days]);

  if (!data.length) return null;
  const chartData = data
    .map(r => ({
      date: r.checked_date,
      passed: r.passed ? 1 : 0,
    }))
    .reverse();

  return (
    <div style={{ marginTop: '0.5rem', marginLeft: '-0.25rem' }}>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
          <XAxis dataKey="date" hide />
          <YAxis domain={[0, 1]} width={28} tick={{ fill: '#8b949e', fontSize: 9 }} tickFormatter={v => (v ? 'pass' : 'fail')} />
          <Tooltip contentStyle={tooltipStyle} formatter={([val]) => [val ? 'pass' : 'fail', '']} labelFormatter={d => d} />
          <Line type="stepAfter" dataKey="passed" stroke="#3fb950" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AssertionDetailsChart({ assertionId, details }) {
  let parsed = [];
  try {
    parsed = typeof details === 'string' ? JSON.parse(details) : details;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  if (assertionId === 'population-drop') {
    const chartData = parsed.map(d => ({
      name: d.dataset,
      'Drop %': parseFloat(d.dropPercent) || 0,
    }));
    return (
      <div style={{ marginTop: '0.5rem', height: Math.max(120, chartData.length * 24) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis type="number" tick={{ fill: '#8b949e', fontSize: 10 }} unit="%" />
            <YAxis dataKey="name" type="category" tick={{ fill: '#8b949e', fontSize: 10 }} width={55} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="Drop %" fill="#f85149" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (assertionId === 'fetch-complete') {
    const chartData = parsed.map(d => ({
      name: d.dataset,
      fetched: d.row_count ?? 0,
      expected: d.api_total ?? 0,
    }));
    return (
      <div style={{ marginTop: '0.5rem', height: Math.max(120, chartData.length * 24) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis type="number" tick={{ fill: '#8b949e', fontSize: 10 }} />
            <YAxis dataKey="name" type="category" tick={{ fill: '#8b949e', fontSize: 10 }} width={55} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend />
            <Bar dataKey="fetched" fill="#58a6ff" name="Fetched" radius={[0, 4, 4, 0]} />
            <Bar dataKey="expected" fill="#e3b341" name="API Total" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}

function AssertionCard({ assertion }) {
  const [expanded, setExpanded] = useState(false);
  const passed = assertion.passed === 1 || assertion.passed === true;

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        ...cardStyle,
        borderColor: passed ? '#238636' : '#da3633',
        cursor: 'pointer',
        minWidth: 200,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{ color: passed ? '#3fb950' : '#f85149', fontSize: '1rem' }}>
          {passed ? '\u2713' : '\u2717'}
        </span>
        <span style={{ color: '#e1e4e8', fontSize: '0.82rem', fontWeight: 500 }}>
          {assertion.assertion_id}
        </span>
      </div>
      {assertion.dataset_name && (
        <div style={{ color: '#8b949e', fontSize: '0.72rem', marginTop: '0.2rem' }}>
          {assertion.dataset_name}
        </div>
      )}
      {expanded && assertion.message && (
        <div style={{ color: '#8b949e', fontSize: '0.75rem', marginTop: '0.4rem', lineHeight: 1.35 }}>
          {assertion.message}
        </div>
      )}
      {expanded && !passed && assertion.details && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop: '0.5rem' }}>
          <AssertionDetailsChart assertionId={assertion.assertion_id} details={assertion.details} />
        </div>
      )}
      {expanded && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop: '0.5rem' }}>
          <AssertionHistoryChart assertionId={assertion.assertion_id} days={14} />
        </div>
      )}
    </div>
  );
}

function PopulationPanel({ data }) {
  // Group by dataset and flatten for chart
  const chartData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    // Group by date; if multiple datasets, show totals per date
    const byDate = {};
    for (const row of data) {
      if (!byDate[row.fetched_date]) {
        byDate[row.fetched_date] = { date: row.fetched_date, row_count: 0, api_total: 0, hasWarning: false };
      }
      byDate[row.fetched_date].row_count += row.row_count || 0;
      byDate[row.fetched_date].api_total += row.api_total || 0;
      if (row.fetch_warnings) byDate[row.fetched_date].hasWarning = true;
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const warningDots = chartData.filter(d => d.hasWarning);

  return (
    <div style={panelStyle}>
      <h3 style={panelTitle}>Population Trend</h3>
      {chartData.length === 0 ? (
        <div style={emptyText}>No population data available</div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="date" tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend />
            <Area
              type="monotone"
              dataKey="row_count"
              stroke="#58a6ff"
              fill="rgba(88,166,255,0.15)"
              name="Fetched Rows"
            />
            <Area
              type="monotone"
              dataKey="api_total"
              stroke="#e3b341"
              fill="none"
              strokeDasharray="5 5"
              name="API Total"
            />
            {warningDots.map(d => (
              <ReferenceDot
                key={d.date}
                x={d.date}
                y={d.row_count}
                r={5}
                fill="#f85149"
                stroke="none"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function FlappingPanel({ data }) {
  return (
    <div style={panelStyle}>
      <h3 style={panelTitle}>Flapping Records <span style={subtitleStyle}>(7-day window)</span></h3>
      {!data || data.length === 0 ? (
        <div style={emptyText}>No flapping detected</div>
      ) : (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Row Key</th>
                <th style={thStyle}>Dataset</th>
                <th style={thStyle}>Flaps</th>
                <th style={thStyle}>Transitions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i}>
                  <td style={tdStyle}><code style={codeStyle}>{row.row_key}</code></td>
                  <td style={tdStyle}>{row.dataset_name}</td>
                  <td style={{ ...tdStyle, color: '#e3b341', fontVariantNumeric: 'tabular-nums' }}>{row.flap_count}</td>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', color: '#8b949e' }}>{row.transitions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FieldStabilityPanel({ data }) {
  const chartData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.slice(0, 15).map(d => ({
      name: d.field_name,
      changes: d.change_count,
    }));
  }, [data]);

  return (
    <div style={panelStyle}>
      <h3 style={panelTitle}>Field Stability <span style={subtitleStyle}>(top 15 most-changed fields, 30d)</span></h3>
      {chartData.length === 0 ? (
        <div style={emptyText}>No field-level changes detected</div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 28)}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 80 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis type="number" tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis dataKey="name" type="category" tick={{ fill: '#8b949e', fontSize: 11 }} width={75} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="changes" fill="#58a6ff" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function SourceSegmentPanel({ data }) {
  // Pivot data for stacked bar chart: group by source, stack by change_type
  const chartData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    const bySource = {};
    for (const row of data) {
      const key = `${row.source} / ${row.scan_type}`;
      if (!bySource[key]) bySource[key] = { source: key, added: 0, removed: 0, modified: 0 };
      if (row.change_type === 'added') bySource[key].added += row.cnt;
      else if (row.change_type === 'removed') bySource[key].removed += row.cnt;
      else if (row.change_type === 'modified') bySource[key].modified += row.cnt;
    }
    return Object.values(bySource);
  }, [data]);

  return (
    <div style={panelStyle}>
      <h3 style={panelTitle}>Source Segmentation</h3>
      {chartData.length === 0 ? (
        <div style={emptyText}>No source segment data available</div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="source" tick={{ fill: '#8b949e', fontSize: 10 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend />
            <Bar dataKey="added" stackId="a" fill="#3fb950" name="Added" />
            <Bar dataKey="removed" stackId="a" fill="#f85149" name="Removed" />
            <Bar dataKey="modified" stackId="a" fill="#e3b341" name="Modified" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ReferentialPanel({ data }) {
  return (
    <div style={panelStyle}>
      <h3 style={panelTitle}>Referential Integrity</h3>
      {!data || data.length === 0 ? (
        <div style={{ color: '#3fb950', padding: '1rem', fontSize: '0.85rem' }}>
          All vulnerability references resolve to known assets
        </div>
      ) : (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          <div style={{ color: '#f85149', fontSize: '0.85rem', padding: '0.5rem 0' }}>
            {data.length} orphaned reference(s) found
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Vulnerable ID</th>
                <th style={thStyle}>Dataset</th>
                <th style={thStyle}>Vuln Count</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i}>
                  <td style={tdStyle}><code style={codeStyle}>{row.vulnerable_id}</code></td>
                  <td style={tdStyle}>{row.dataset_name}</td>
                  <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{row.vuln_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Shared Styles ───────────────────────────────────────────────

const headerStyle = {
  color: '#e1e4e8',
  fontSize: '1.25rem',
  fontWeight: 600,
};

const selectStyle = {
  background: '#21262d',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.4rem 0.75rem',
  fontSize: '0.85rem',
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

const subtitleStyle = {
  color: '#8b949e',
  fontWeight: 400,
  fontSize: '0.8rem',
};

const cardStyle = {
  background: '#0d1117',
  border: '1px solid',
  borderRadius: 8,
  padding: '0.65rem 0.85rem',
  minWidth: 140,
  flex: '0 0 auto',
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

const codeStyle = {
  background: '#21262d',
  padding: '0.15rem 0.4rem',
  borderRadius: 4,
  fontSize: '0.8rem',
  fontFamily: 'SF Mono, Monaco, Consolas, monospace',
};

const emptyText = {
  color: '#8b949e',
  padding: '1rem',
  fontSize: '0.85rem',
};

const tooltipStyle = {
  backgroundColor: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  color: '#e1e4e8',
  fontSize: '0.82rem',
};
