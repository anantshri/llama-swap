// Stats page: per-model aggregated metrics served by the backend from
// /api/metrics/stats. Aggregation happens in SQL over the entire activity
// log, so no request-count limit applies.
import { el, cleanupAll } from "../dom.js";

const nf = new Intl.NumberFormat();

function formatSpeed(s) {
  return s == null || s < 0 ? "—" : s.toFixed(2) + " t/s";
}

function formatDuration(ms, count) {
  if (count === 0 || ms <= 0) return "—";
  const avg = ms / count;
  if (avg < 1000) return avg.toFixed(0) + "ms";
  return (avg / 1000).toFixed(2) + "s";
}

function formatRelativeTime(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "now";
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return "a while ago";
}

export function StatsPage() {
  const root = el(`
    <div class="page page-stats">
      <h2 class="stats-heading">Model Usage Stats</h2>

      <!-- Summary row -->
      <div class="stats-summary card" data-summary></div>

      <!-- Time range info -->
      <p class="stats-timespan" data-timespan></p>

      <!-- Per-model table -->
      <div class="card stats-table-wrap">
        <table class="stats-table">
          <thead>
            <tr>
              <th class="stats-th stats-th-model stats-th-sortable" data-sort="model">Model<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="requests">Requests<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="inputTokens">Input Tokens<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="outputTokens">Output Tokens<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="cachedTokens">Cached Tokens<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="avgPromptSpeed">Avg Prompt Speed<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="avgGenSpeed">Avg Gen Speed<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="avgDuration">Avg Duration<span class="stats-sort-ind"></span></th>
              <th class="stats-th stats-th-num stats-th-sortable" data-sort="lastTimestamp">Last Used<span class="stats-sort-ind"></span></th>
            </tr>
          </thead>
          <tbody data-body></tbody>
        </table>
      </div>
    </div>
  `);

  const summaryEl = root.querySelector("[data-summary]");
  const timespanEl = root.querySelector("[data-timespan]");
  const body = root.querySelector("[data-body]");

  let sortKey = "requests";
  let sortOrder = "desc";

  async function fetchStats() {
    try {
      // The backend aggregates over the whole activity log (SQL GROUP BY);
      // the response shape is store.ActivityStats from /api/metrics/stats.
      const resp = await fetch("/api/metrics/stats");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const stats = await resp.json();
      return {
        totalRequests: stats.total_requests || 0,
        totalInput: stats.total_input_tokens || 0,
        totalOutput: stats.total_output_tokens || 0,
        totalCached: stats.total_cache_tokens || 0,
        firstTime: stats.first_timestamp || null,
        lastTime: stats.last_timestamp || null,
        models: Array.isArray(stats.models) ? stats.models : [],
      };
    } catch (err) {
      console.error("Failed to fetch stats:", err);
      return { totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null, models: [] };
    }
  }

  function renderSummary(stats) {
    if (stats.totalRequests === 0) {
      summaryEl.innerHTML = `<div class="stats-summary-empty">No metrics recorded yet.</div>`;
      return;
    }

    summaryEl.innerHTML = `
      <div class="stats-summary-inner">
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.totalRequests)}</span>
          <span class="stats-stat-label">Requests</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.totalInput)}</span>
          <span class="stats-stat-label">Input Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.totalOutput)}</span>
          <span class="stats-stat-label">Output Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.totalCached)}</span>
          <span class="stats-stat-label">Cached Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.models.length)}</span>
          <span class="stats-stat-label">Models Used</span>
        </div>
      </div>
    `;
  }

  function renderTimespan(firstTime, lastTime, totalReqs, modelCount) {
    if (!firstTime || !lastTime) {
      timespanEl.textContent = "";
      return;
    }
    const first = new Date(firstTime);
    const last = new Date(lastTime);
    const fmt = (d) => d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    timespanEl.textContent = `Data range: ${fmt(first)} — ${fmt(last)} (${nf.format(totalReqs)} requests across ${modelCount} models)`;
  }

  function sortValue(s) {
    switch (sortKey) {
      case "requests": return s.requests;
      case "inputTokens": return s.input_tokens;
      case "outputTokens": return s.output_tokens;
      case "cachedTokens": return s.cached_tokens;
      case "avgPromptSpeed": return s.avg_prompt_speed == null ? -1 : s.avg_prompt_speed;
      case "avgGenSpeed": return s.avg_gen_speed == null ? -1 : s.avg_gen_speed;
      case "avgDuration": return s.requests > 0 ? (s.total_duration_ms || 0) / s.requests : 0;
      case "lastTimestamp": return s.last_used || 0;
      default: return 0;
    }
  }

  function compareRows(a, b) {
    const dir = sortOrder === "asc" ? 1 : -1;
    let cmp;
    if (sortKey === "model") {
      cmp = a.model.localeCompare(b.model);
    } else {
      cmp = sortValue(a) - sortValue(b);
    }
    if (cmp === 0) cmp = a.model.localeCompare(b.model);
    return cmp * dir;
  }

  function renderSortIndicator() {
    root.querySelectorAll("th[data-sort]").forEach((th) => {
      const span = th.querySelector(".stats-sort-ind");
      if (!span) return;
      if (th.dataset.sort === sortKey) {
        span.textContent = sortOrder === "asc" ? "▲" : "▼";
        span.classList.add("active");
      } else {
        span.textContent = "";
        span.classList.remove("active");
      }
    });
  }

  function renderTable(stats) {
    if (stats.totalRequests === 0) {
      body.innerHTML = `<tr><td class="stats-empty" colspan="9">No activity recorded</td></tr>`;
      renderSortIndicator();
      return;
    }

    const sorted = [...stats.models].sort(compareRows);

    body.innerHTML = sorted
      .map((s) => {
        const totalDuration = s.total_duration_ms;

        return `<tr class="stats-tr">
          <td class="stats-td stats-td-model">${escapeHtml(s.model)}</td>
          <td class="stats-td stats-td-num">${nf.format(s.requests)}</td>
          <td class="stats-td stats-td-num">${nf.format(s.input_tokens)}</td>
          <td class="stats-td stats-td-num">${nf.format(s.output_tokens)}</td>
          <td class="stats-td stats-td-num">${s.cached_tokens > 0 ? nf.format(s.cached_tokens) : "—"}</td>
          <td class="stats-td stats-td-num">${formatSpeed(s.avg_prompt_speed)}</td>
          <td class="stats-td stats-td-num">${formatSpeed(s.avg_gen_speed)}</td>
          <td class="stats-td stats-td-num">${formatDuration(totalDuration, s.requests)}</td>
          <td class="stats-td stats-td-num">${s.last_used ? formatRelativeTime(s.last_used) : "—"}</td>
        </tr>`;
      })
      .join("");
    renderSortIndicator();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Initial load
  let stats = { totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null, models: [] };
  let loading = true;

  root.querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (key === sortKey) {
      sortOrder = sortOrder === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortOrder = "desc";
    }
    renderTable(stats);
  });

  // Placeholder during load
  summaryEl.innerHTML = `<div class="stats-summary-empty">Loading...</div>`;

  fetchStats().then((fetched) => {
    stats = fetched;
    renderSummary(stats);
    renderTimespan(stats.firstTime, stats.lastTime, stats.totalRequests, stats.models.length);
    renderTable(stats);
    loading = false;
  });

  return {
    el: root,
    destroy() {
      // No timers or subscriptions to clean up
    },
  };
}
