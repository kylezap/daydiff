/**
 * Executive Report Generator
 *
 * Builds a compact summary of daily diff data and uses an LLM to produce
 * an executive report. Called after each run when OPENAI_API_KEY is set.
 */

import OpenAI from 'openai';
import { getDb } from '../db/index.mjs';
import {
  getSummaryForDate,
  getDiffItemsPaginated,
  insertExecutiveReport,
} from '../db/queries.mjs';
import { getModifiedFieldCountsByDiff } from '../analysis/queries.mjs';
import { getNestedPathPatterns, getAddedRemovedPatterns } from './patternAnalysis.mjs';
import config from '../../config/default.mjs';
import { log } from '../lib/logger.mjs';

const MAX_LEN = 150;
const MAX_SAMPLE = config.report?.maxSamplePerType ?? 5;

/**
 * Extract a display name from row_data JSON. Tries name, title, id in order.
 * @param {string|object} rowData - JSON string or parsed object
 * @returns {string|null}
 */
export function extractDisplayName(rowData) {
  if (!rowData) return null;
  let data;
  try {
    data = typeof rowData === 'string' ? JSON.parse(rowData) : rowData;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const val = data.name ?? data.title ?? data.id ?? data.row_key;
  if (val == null) return null;
  const str = String(val);
  return str.length > MAX_LEN ? str.slice(0, MAX_LEN) + '...' : str;
}

/**
 * Build a short summary of field_changes for modified items.
 * @param {string|object} fieldChanges - JSON string or parsed object
 * @param {string|string[]} changedFields - JSON array string or array
 * @returns {string|null}
 */
export function summarizeFieldChanges(fieldChanges, changedFields) {
  if (!fieldChanges || !changedFields) return null;
  let changes;
  try {
    changes = typeof fieldChanges === 'string' ? JSON.parse(fieldChanges) : fieldChanges;
  } catch {
    return null;
  }
  if (!changes || typeof changes !== 'object') return null;
  const parts = [];
  for (const field of (Array.isArray(changedFields) ? changedFields : JSON.parse(changedFields || '[]'))) {
    const c = changes[field];
    if (c && (c.old !== undefined || c.new !== undefined)) {
      const oldStr = c.old != null ? String(c.old).slice(0, 50) : 'null';
      const newStr = c.new != null ? String(c.new).slice(0, 50) : 'null';
      parts.push(`${field}: ${oldStr} → ${newStr}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Sample diff items for a dataset, extracting minimal display info.
 */
function sampleDiffItems(diffId, maxPerType) {
  const samples = { added: [], removed: [], modified: [] };
  for (const changeType of ['added', 'removed', 'modified']) {
    const { rows } = getDiffItemsPaginated(diffId, {
      changeType,
      limit: maxPerType,
      offset: 0,
    });
    for (const row of rows) {
      const name = extractDisplayName(row.row_data) || row.row_key;
      const item = { row_key: row.row_key, name };
      if (changeType === 'modified' && row.field_changes) {
        item.changes_summary = summarizeFieldChanges(row.field_changes, row.changed_fields);
        if (row.changed_fields) {
          try {
            item.changed_fields = JSON.parse(row.changed_fields);
          } catch {
            item.changed_fields = [];
          }
        }
      }
      samples[changeType].push(item);
    }
  }
  return samples;
}

/**
 * Build the compact payload for the LLM.
 */
function buildPayload(date) {
  const platform = getSummaryForDate(date, 'platform');
  const vuln = getSummaryForDate(date, 'vulnerability');

  const payload = {
    date,
    platform: [],
    vulnerability: [],
  };

  for (const category of ['platform', 'vulnerability']) {
    const summaries = category === 'platform' ? platform : vuln;
    for (const s of summaries) {
      const totalChanges = s.added_count + s.removed_count + s.modified_count;
      const entry = {
        dataset: s.dataset_name,
        from_date: s.from_date,
        to_date: s.to_date,
        added: s.added_count,
        removed: s.removed_count,
        modified: s.modified_count,
        unchanged: s.unchanged_count,
      };
      if (totalChanges > 0) {
        entry.samples = sampleDiffItems(s.diff_id, MAX_SAMPLE);
        entry.modified_field_patterns = getModifiedFieldCountsByDiff(s.diff_id);
        const nestedPatterns = getNestedPathPatterns(s.diff_id, s.modified_count);
        if (nestedPatterns.length > 0) {
          entry.modified_nested_patterns = nestedPatterns;
        }
        if (s.added_count > 0) {
          entry.added_patterns = getAddedRemovedPatterns(s.diff_id, 'added');
        }
        if (s.removed_count > 0) {
          entry.removed_patterns = getAddedRemovedPatterns(s.diff_id, 'removed');
        }
      }
      payload[category].push(entry);
    }
  }

  return payload;
}

const SYSTEM_PROMPT = `You are an executive summarizer for a daily data-diff report. Given JSON data describing adds, removes, and modifications to platform resources (applications, components, repositories, etc.) and vulnerability data, produce a concise markdown report that highlights the most significant changes and any patterns or trends.

Structure your report as follows:
- Use clear section headers: ## Platform Changes and ## Vulnerability Changes.
- Within each section, summarize **each dataset separately** (e.g. Applications, Components, Resources, Repositories, and each vulnerability dataset). For each dataset, state what changed: added, removed, and modified counts, and any patterns.

Use the following data when present:
- **modified_field_patterns**: Lists which top-level fields changed most often in modified rows. Call out the fields that dominate (e.g. "most modifications touched field X").
- **modified_nested_patterns**: When present, these are nested paths inside JSON-shaped fields (e.g. providerSpecificDetails.cpu) that changed. Note when changes are concentrated in nested JSON fields.
- **added_patterns** and **removed_patterns**: When present, use keys_present to note which attributes are common across added/removed rows. Use value_distribution (e.g. status, severity, criticality) to highlight trends such as "most added vulns are CRITICAL" or "removed rows were mostly status X".
- **samples**: Use specific names (repositories, applications, etc.) when mentioning examples.

Focus on what changed and why it might matter to an executive audience. If a category or dataset has no changes, say so briefly.`;

/**
 * Generate the executive report for a given date and persist it.
 * @param {string} date - YYYY-MM-DD
 */
export async function generateExecutiveReport(date) {
  getDb(); // Ensure DB is initialized

  const payload = buildPayload(date);
  const hasData =
    payload.platform.some((p) => p.added + p.removed + p.modified > 0) ||
    payload.vulnerability.some((v) => v.added + v.removed + v.modified > 0);

  if (!hasData) {
    log('[report] No diff changes for this date; skipping report generation');
    return;
  }

  const model = config.report?.model ?? 'gpt-4o-mini';
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPrompt = `Daily diff data for ${date}:\n\n${JSON.stringify(payload, null, 2)}`;

  log('[report] Generating executive report...');

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM returned empty response');
  }

  insertExecutiveReport(date, content, model);
  log('[report] Executive report saved');
}
