# RAG Architecture Plan

## Overview

Retrieval-Augmented Generation (RAG) can add value to DayDiff by giving the LLM access to historical context, assertion results, and other stored knowledge. Today the executive report in `src/report/executive.mjs` receives only the current day's JSON payload and has no memory of prior reports or quality checks.

---

## Current State

| Component | Behavior |
|-----------|----------|
| **Executive report** | LLM receives compact JSON (today's diff summary + samples). No historical context. |
| **Data sources** | `executive_reports`, `diffs`, `diff_items`, `assertion_results`, `snapshot_rows` in SQLite. EDA notebook (`notebooks/vulnerability_eda.ipynb`). |
| **LLM** | OpenAI (gpt-4o-mini default), single-turn completion. |

---

## Use Cases

### 1. Executive Report Enhancement (Priority: High)

**Problem:** The report only sees today's data. It cannot reference prior weeks or mention assertion failures.

**RAG approach:**
- Retrieve past executive reports (last 7–14 days) for trend continuity.
- Retrieve assertion results for the current date (population-drop, fetch-complete, flapping, etc.).
- Append retrieved context to the system prompt so the LLM can mention:
  - Recurring patterns (“similar churn to last week”)
  - Quality issues (“Population drop detected in vulns-Digital One LFI”)

**Impact:** Reports become context-aware and highlight what matters most.

---

### 2. Natural-Language Q&A Over Diff Data (Priority: Medium)

**Problem:** Users must browse the dashboard or run queries to answer questions.

**RAG approach:**
- Add a chat-style interface to the dashboard.
- User asks: “Which applications had the most vulnerability changes this month?”
- Flow: embed query → retrieve from vector index (diff summaries, reports, assertion results) → LLM synthesizes answer.

**Index contents:**
- Diff summaries (dataset, date, change counts).
- Executive report excerpts (by date).
- Assertion results (passed/failed, message, dataset).

---

### 3. EDA Notebook as Knowledge Base (Priority: Low)

**Problem:** The vulnerability EDA notebook defines risk scoring, change dynamics, per-asset comparisons—but that knowledge is not used by the LLM.

**RAG approach:**
- Chunk markdown and key code/findings from `notebooks/vulnerability_eda.ipynb`.
- Embed and index chunks.
- Retrieve when generating reports or answering questions about vulnerability trends or risk scoring.

---

### 4. Internal Documentation / Runbooks (Priority: Optional)

**Problem:** No way to ground recommendations in org-specific procedures.

**RAG approach:**
- Index runbooks, playbooks, asset ownership docs.
- Retrieve when generating reports or answering “what should I do?” questions.
- Tie recommendations to concrete procedures (e.g., “Follow Playbook X for population drops”).

---

## Technical Components

| Component | Description |
|-----------|-------------|
| **Embeddings** | OpenAI `text-embedding-3-small` (or similar) for queries and indexed content. |
| **Vector store** | SQLite + `sqlite-vss`, Chroma, or another vector DB for embeddings and similarity search. |
| **Indexing pipeline** | Periodic job to embed and upsert: executive reports, diff summaries, assertion results. Optional: EDA notebook chunks. |
| **Retrieval layer** | Query-time retrieval of top-k chunks by vector similarity. |
| **Prompt augmentation** | Include retrieved chunks in the system or user prompt. |

---

## Recommended Phasing

### Phase 1: Executive Report Enhancement

1. Create a minimal vector index of:
   - Past executive reports (by date).
   - Assertion results (by date, dataset, assertion_id).
2. At report generation time:
   - Retrieve last N days of reports.
   - Retrieve assertion failures for the target date.
3. Append retrieved context to `executive.mjs` system prompt.

**Deliverables:**
- `src/rag/index.mjs` — embedding and indexing helpers.
- `src/rag/retrieve.mjs` — retrieval for report generation.
- Updated `src/report/executive.mjs` — fetch context and pass to LLM.

---

### Phase 2: Q&A Interface

1. Expose retrieval as an API endpoint (`GET /api/rag/search` or `POST /api/rag/ask`).
2. Add chat UI to the dashboard.
3. Index diff summaries and assertion results if not already indexed.

---

### Phase 3: EDA and Documentation (Optional)

1. Build chunker for Jupyter notebooks.
2. Index EDA notebook markdown and findings.
3. Optionally index external docs (runbooks, playbooks) if available.

---

## Data Schema for RAG Index (Draft)

```
-- RAG chunks table (if using SQLite + sqlite-vss)
CREATE TABLE rag_chunks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,        -- 'executive_report' | 'assertion_result' | 'diff_summary' | 'notebook'
  source_id TEXT,              -- report_date, assertion result id, diff id, etc.
  content TEXT NOT NULL,
  embedding BLOB,              -- vector (dimension depends on model)
  metadata TEXT,               -- JSON: { dataset, date, change_type, ... }
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## References

- `src/report/executive.mjs` — current LLM integration.
- `src/db/queries.mjs` — `getSummaryForDate`, `getDiffItemsPaginated`, etc.
- `src/db/schema.sql` — `executive_reports`, `assertion_results`, `diffs`.
- `config/assertions.mjs` — assertion rule definitions.
- `notebooks/vulnerability_eda.ipynb` — EDA content for optional indexing.
