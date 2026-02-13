import React from 'react';
import { NavLink } from 'react-router-dom';

const linkClass = ({ isActive }) =>
  `sidebar-link ${isActive ? 'active' : ''}`;

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">DayDiff</div>

      <div className="sidebar-group">
        <div className="sidebar-label">Platform</div>
        <NavLink to="/platform" end className={linkClass}>Overview</NavLink>
        <NavLink to="/platform/diff" className={linkClass}>Diff Detail</NavLink>
      </div>

      <div className="sidebar-group">
        <div className="sidebar-label">Vulnerabilities</div>
        <NavLink to="/vulns" end className={linkClass}>Overview</NavLink>
        <NavLink to="/vulns/diff" className={linkClass}>Diff Detail</NavLink>
      </div>

      <div className="sidebar-group">
        <div className="sidebar-label">Data Quality</div>
        <NavLink to="/quality" end className={linkClass}>Overview</NavLink>
      </div>

      <style>{`
        .sidebar {
          width: 200px;
          min-width: 200px;
          background: #0d1117;
          border-right: 1px solid #21262d;
          display: flex;
          flex-direction: column;
          padding: 0;
          height: 100vh;
          position: sticky;
          top: 0;
          overflow-y: auto;
        }
        .sidebar-brand {
          font-size: 1.15rem;
          font-weight: 700;
          color: #58a6ff;
          letter-spacing: -0.5px;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid #21262d;
        }
        .sidebar-group {
          padding: 0.75rem 0 0.25rem;
        }
        .sidebar-label {
          color: #484f58;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          padding: 0 1.25rem 0.4rem;
        }
        .sidebar-link {
          display: block;
          color: #8b949e;
          text-decoration: none;
          padding: 0.45rem 1.25rem;
          font-size: 0.85rem;
          font-weight: 500;
          transition: all 0.12s;
          border-left: 3px solid transparent;
        }
        .sidebar-link:hover {
          color: #e1e4e8;
          background: #161b22;
        }
        .sidebar-link.active {
          color: #f0f6fc;
          background: #161b22;
          border-left-color: #58a6ff;
        }
      `}</style>
    </aside>
  );
}
