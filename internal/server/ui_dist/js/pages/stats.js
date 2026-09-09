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
              <th class="stats-th stats-th-model">Model</th>
              <th class="stats-th stats-th-num">Requests</th>
              <th class="stats-th stats-th-num">Input Tokens</th>
              <th class="stats-th stats-th-num">Output Tokens</th>
              <th class="stats-th stats-th-num">Cached Tokens</th>
              <th class="stats-th stats-th-num">Avg Prompt Speed</th>
              <th class="stats-th stats-th-num">Avg Gen Speed</th>
              <th class="stats-th stats-th-num">Avg Duration</th>
              <th class="stats-th stats-th-num">Last Used</th>
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

  function renderTable(stats) {
    if (stats.totalRequests === 0) {
      body.innerHTML = `<tr><td class="stats-empty" colspan="9">No activity recorded</td></tr>`;
      return;
    }

    // The backend orders models by request count descending; keep that order.
    body.innerHTML = stats.models
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
