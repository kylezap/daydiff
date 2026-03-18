import React, { useState, useEffect, useRef } from "react";
import {
  fetchAssertions,
  fetchAssertionSummary,
  fetchPopulation,
  fetchFlapping,
  fetchFieldStability,
  fetchSourceSegments,
  fetchReferential,
  fetchDatasets,
} from "../api/client.js";
import QualityTabBar from "../components/quality/QualityTabBar.jsx";
import {
  QualityAssertionsTab,
  QualityPopulationTab,
  QualityIntegrityTab,
} from "../components/quality/QualityTabPanels.jsx";

// ─── Main Page ───────────────────────────────────────────────────
const QUALITY_STALL_MS = 12000;
const QUALITY_TIMEOUT_MS = 20000;

export default function Quality() {
  const [activeTab, setActiveTab] = useState("assertions");
  const [category, setCategory] = useState("platform"); // 'platform' | 'vulnerability' | ''
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [tabLoading, setTabLoading] = useState({
    assertions: true,
    population: false,
    integrity: false,
  });
  const [tabErrors, setTabErrors] = useState({
    assertions: null,
    population: null,
    integrity: null,
  });
  const [requestStalled, setRequestStalled] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Panel data
  const [assertions, setAssertions] = useState([]);
  const [assertionSummary, setAssertionSummary] = useState([]);
  const [population, setPopulation] = useState([]);
  const [flapping, setFlapping] = useState([]);
  const [fieldStability, setFieldStability] = useState([]);
  const [sourceSegments, setSourceSegments] = useState([]);
  const [referential, setReferential] = useState([]);
  const qualityCacheRef = useRef(new Map());

  // Single ResizeObserver for all charts (avoids N observers on unmount = faster navigation)
  const contentRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(640);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (typeof w === "number" && w > 0) setContentWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const catParam = category || undefined; // '' means all
  const activeTabError = tabErrors[activeTab];
  const activeTabLoading = tabLoading[activeTab];

  // Load datasets when category changes (scoped to platform/vuln when selected)
  useEffect(() => {
    const ac = new AbortController();
    fetchDatasets(catParam, { signal: ac.signal })
      .then(setDatasets)
      .catch((err) => {
        if (err.name !== "AbortError") {
          setTabErrors((prev) => ({
            ...prev,
            assertions: err.message,
            population: err.message,
            integrity: err.message,
          }));
        }
      });
    return () => ac.abort();
  }, [catParam]);

  // Invalidate quality cache whenever filters change.
  useEffect(() => {
    qualityCacheRef.current.clear();
  }, [catParam, selectedDatasetId]);

  function getCacheKey(tab, date) {
    const catKey = catParam || "all";
    const dsKey = selectedDatasetId || "all";
    return `${tab}|${catKey}|${dsKey}|${date}|30`;
  }

  function applyCachedData(tab, payload) {
    if (tab === "assertions") {
      setAssertions(payload.assertions ?? []);
      setAssertionSummary(payload.assertionSummary ?? []);
      return;
    }
    if (tab === "population") {
      setPopulation(payload.population ?? []);
      return;
    }
    setFlapping(payload.flapping ?? []);
    setFieldStability(payload.fieldStability ?? []);
    setSourceSegments(payload.sourceSegments ?? []);
    setReferential(payload.referential ?? []);
  }

  // Lazy-load only the active tab data, then cache per tab+filter key.
  useEffect(() => {
    const ac = new AbortController();
    const signal = ac.signal;
    let cancelled = false;
    let stallTimer = null;

    async function load() {
      const today = new Date().toISOString().slice(0, 10);
      const cacheKey = getCacheKey(activeTab, today);
      if (qualityCacheRef.current.has(cacheKey)) {
        const cached = qualityCacheRef.current.get(cacheKey);
        applyCachedData(activeTab, cached);
        setTabLoading((prev) => ({ ...prev, [activeTab]: false }));
        setTabErrors((prev) => ({ ...prev, [activeTab]: null }));
        setRequestStalled(false);
        return;
      }

      try {
        setTabLoading((prev) => ({ ...prev, [activeTab]: true }));
        setTabErrors((prev) => ({ ...prev, [activeTab]: null }));
        setRequestStalled(false);
        stallTimer = setTimeout(() => {
          if (!cancelled) setRequestStalled(true);
        }, QUALITY_STALL_MS);

        const dsId = selectedDatasetId || undefined;
        const reqOptions = { signal, timeoutMs: QUALITY_TIMEOUT_MS };
        let payload = null;

        if (activeTab === "assertions") {
          const [assertionsData, summaryData] = await Promise.all([
            fetchAssertions(today, reqOptions),
            fetchAssertionSummary(30, reqOptions),
          ]);
          payload = {
            assertions: assertionsData ?? [],
            assertionSummary: summaryData ?? [],
          };
        } else if (activeTab === "population") {
          const populationData = await fetchPopulation(30, dsId, catParam, reqOptions);
          payload = { population: populationData ?? [] };
        } else {
          const [flappingData, fieldStabilityData, sourceSegmentsData, referentialData] =
            await Promise.all([
              fetchFlapping(dsId, 7, catParam, reqOptions),
              fetchFieldStability(dsId, 30, catParam, reqOptions),
              fetchSourceSegments(dsId, undefined, catParam, reqOptions),
              catParam === "platform"
                ? Promise.resolve([])
                : fetchReferential(today, reqOptions),
            ]);
          payload = {
            flapping: flappingData ?? [],
            fieldStability: fieldStabilityData ?? [],
            sourceSegments: sourceSegmentsData ?? [],
            referential: referentialData ?? [],
          };
        }

        if (!cancelled && payload) {
          qualityCacheRef.current.set(cacheKey, payload);
          applyCachedData(activeTab, payload);
        }
      } catch (err) {
        if (!cancelled && err.name !== "AbortError") {
          setTabErrors((prev) => ({ ...prev, [activeTab]: err.message }));
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        if (!cancelled) {
          setTabLoading((prev) => ({ ...prev, [activeTab]: false }));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (stallTimer) clearTimeout(stallTimer);
      ac.abort();
    };
  }, [activeTab, selectedDatasetId, catParam, retryNonce]);

  return (
    <div ref={contentRef} style={{ minWidth: 0 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.25rem",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <h2 style={headerStyle}>Data Quality</h2>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setSelectedDatasetId("");
              setActiveTab("assertions");
            }}
            style={selectStyle}
            title="Filter quality data by dataset category"
          >
            <option value="platform">Platform</option>
            <option value="vulnerability">Vulnerabilities</option>
            <option value="">All</option>
          </select>
          <select
            value={selectedDatasetId}
            onChange={(e) => setSelectedDatasetId(e.target.value)}
            style={selectStyle}
          >
            <option value="">All Datasets</option>
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <QualityTabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTabLoading && (
        <div style={{ color: "#8b949e", padding: "1rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
          Loading quality data...
          {requestStalled && (
            <button
              type="button"
              onClick={() => setRetryNonce((k) => k + 1)}
              style={{
                background: "#21262d",
                color: "#e1e4e8",
                border: "1px solid #30363d",
                borderRadius: 6,
                padding: "0.3rem 0.55rem",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              Retry now
            </button>
          )}
        </div>
      )}

      {activeTabError && !activeTabLoading && (
        <div style={{ color: "#f85149", padding: "1rem", border: "1px solid #30363d", borderRadius: 8, marginBottom: "1rem" }}>
          <strong>Error:</strong> {activeTabError}
        </div>
      )}

      {activeTab === "assertions" && (
        <QualityAssertionsTab
          assertionSummary={assertionSummary}
          assertions={assertions}
          contentWidth={contentWidth}
        />
      )}

      {activeTab === "population" && (
        <QualityPopulationTab population={population} contentWidth={contentWidth} />
      )}

      {activeTab === "integrity" && (
        <QualityIntegrityTab
          flapping={flapping}
          fieldStability={fieldStability}
          sourceSegments={sourceSegments}
          referential={referential}
          contentWidth={contentWidth}
        />
      )}
    </div>
  );
}

const headerStyle = {
  color: "#e1e4e8",
  fontSize: "1.25rem",
  fontWeight: 600,
};

const selectStyle = {
  background: "#21262d",
  color: "#e1e4e8",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "0.4rem 0.75rem",
  fontSize: "0.85rem",
};
