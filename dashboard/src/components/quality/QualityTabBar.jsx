import React from "react";

export const QUALITY_TABS = [
  { id: "assertions", label: "Assertions" },
  { id: "population", label: "Population" },
  { id: "integrity", label: "Integrity / Diagnostics" },
];

export default function QualityTabBar({ activeTab, onTabChange }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        marginBottom: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      {QUALITY_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          style={{
            background: tab.id === activeTab ? "#21262d" : "#0d1117",
            color: tab.id === activeTab ? "#e1e4e8" : "#8b949e",
            border: `1px solid ${tab.id === activeTab ? "#58a6ff" : "#30363d"}`,
            borderRadius: 6,
            padding: "0.35rem 0.75rem",
            fontSize: "0.8rem",
            cursor: "pointer",
            fontWeight: tab.id === activeTab ? 600 : 400,
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
