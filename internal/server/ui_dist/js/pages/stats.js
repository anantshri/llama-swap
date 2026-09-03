// Stats page: per-model aggregated metrics computed client-side from the
// activity log (/api/metrics/activity). Reduces the entries by model.
import { el, cleanupAll } from "../dom.js";

const nf = new Intl.NumberFormat();

function formatSpeed(s) {
  return s < 0 ? "—" : s.toFixed(2) + " t/s";
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

  // Client-side column sorting. Default matches the previous behaviour:
  // most requests first.
  let sortKey = "requests";
  let sortOrder = "desc";

  async function fetchMetrics() {
    try {
      // Upstream serves the activity log at /api/metrics/activity as a paginated
      // page ({data:[...]}); the entry shape (tokens.*, timestamp, model,
      // duration_ms) matches what aggregate() expects. limit is capped server
      // side (<1000), so this aggregates over the most recent requests.
      const resp = await fetch("/api/metrics/activity?limit=999");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const page = await resp.json();
      return Array.isArray(page) ? page : (page.data || []);
    } catch (err) {
      console.error("Failed to fetch metrics:", err);
      return [];
    }
  }

  function aggregate(metrics) {
    if (!metrics || metrics.length === 0) {
      return { models: new Map(), totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null };
    }

    const models = new Map();
    let totalRequests = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    let firstTime = null;
    let lastTime = null;

    for (const m of metrics) {
      totalRequests++;
      totalInput += m.tokens.input_tokens || 0;
      totalOutput += m.tokens.output_tokens || 0;
      totalCached += Math.max(0, m.tokens.cache_tokens || 0);

      if (!firstTime || m.timestamp < firstTime) firstTime = m.timestamp;
      if (!lastTime || m.timestamp > lastTime) lastTime = m.timestamp;

      const model = m.model || "(unknown)";
      if (!models.has(model)) {
        models.set(model, {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          promptSpeeds: [],
          genSpeeds: [],
          durations: [],
          lastTimestamp: null,
        });
      }
      const s = models.get(model);
      s.requests++;
      s.inputTokens += m.tokens.input_tokens || 0;
      s.outputTokens += m.tokens.output_tokens || 0;
      s.cachedTokens += Math.max(0, m.tokens.cache_tokens || 0);
      if (m.tokens.prompt_per_second > 0) s.promptSpeeds.push(m.tokens.prompt_per_second);
      if (m.tokens.tokens_per_second > 0) s.genSpeeds.push(m.tokens.tokens_per_second);
      s.durations.push(m.duration_ms);
      if (!s.lastTimestamp || m.timestamp > s.lastTimestamp) s.lastTimestamp = m.timestamp;
    }

    return { models, totalRequests, totalInput, totalOutput, totalCached, firstTime, lastTime };
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
          <span class="stats-stat-value">${stats.models.size}</span>
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

  function toRow(model, s) {
    const avgPromptSpeed = s.promptSpeeds.length > 0
      ? s.promptSpeeds.reduce((a, b) => a + b, 0) / s.promptSpeeds.length
      : -1;
    const avgGenSpeed = s.genSpeeds.length > 0
      ? s.genSpeeds.reduce((a, b) => a + b, 0) / s.genSpeeds.length
      : -1;
    const totalDuration = s.durations.reduce((a, b) => a + b, 0);
    return {
      model,
      requests: s.requests,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cachedTokens: s.cachedTokens,
      avgPromptSpeed,
      avgGenSpeed,
      avgDuration: s.requests > 0 ? totalDuration / s.requests : 0,
      totalDuration,
      lastTimestamp: s.lastTimestamp || 0,
    };
  }

  function compareRows(a, b) {
    const dir = sortOrder === "asc" ? 1 : -1;
    let cmp;
    if (sortKey === "model") {
      cmp = a.model.localeCompare(b.model);
    } else {
      cmp = a[sortKey] - b[sortKey];
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

    const sorted = [...stats.models.entries()]
      .map(([model, s]) => toRow(model, s))
      .sort(compareRows);
    renderSortIndicator();

    body.innerHTML = sorted
      .map((row) => {
        return `<tr class="stats-tr">
          <td class="stats-td stats-td-model">${escapeHtml(row.model)}</td>
          <td class="stats-td stats-td-num">${nf.format(row.requests)}</td>
          <td class="stats-td stats-td-num">${nf.format(row.inputTokens)}</td>
          <td class="stats-td stats-td-num">${nf.format(row.outputTokens)}</td>
          <td class="stats-td stats-td-num">${row.cachedTokens > 0 ? nf.format(row.cachedTokens) : "—"}</td>
          <td class="stats-td stats-td-num">${formatSpeed(row.avgPromptSpeed)}</td>
          <td class="stats-td stats-td-num">${formatSpeed(row.avgGenSpeed)}</td>
          <td class="stats-td stats-td-num">${formatDuration(row.totalDuration, row.requests)}</td>
          <td class="stats-td stats-td-num">${row.lastTimestamp ? formatRelativeTime(row.lastTimestamp) : "—"}</td>
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

  // Click a column header to sort; click again to toggle asc/desc.
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
    renderSortIndicator();
    renderTable(stats);
  });

  // Initial load
  let stats = { models: new Map(), totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null };
  let loading = true;

  // Placeholder during load
  summaryEl.innerHTML = `<div class="stats-summary-empty">Loading...</div>`;

  fetchMetrics().then((metrics) => {
    stats = aggregate(metrics);
    renderSummary(stats);
    renderTimespan(stats.firstTime, stats.lastTime, stats.totalRequests, stats.models.size);
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
