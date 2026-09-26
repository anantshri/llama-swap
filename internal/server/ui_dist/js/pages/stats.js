// Stats page: per-model aggregated metrics served by the backend from
// /api/metrics/stats. Aggregation happens in SQL over the entire activity
// log, so no request-count limit applies. Rows for models still present in
// the running configuration are listed under "Active Models"; history for
// models that have since been removed (or renamed) moves to "Inactive
// Models" below.
import { el, cleanupAll } from "../dom.js";
import { compactNumbers, currencyPref, defaultRatesPref, inrPerUsdPref, showCost } from "../preferences.js";
import { formatCompactNumber } from "../util/format.js";
import { estimateCostUSD, formatCost, resolveRates } from "../util/pricing.js";
import { models } from "../api.js";

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
  const theadHtml = `
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
    </thead>`;

  const root = el(`
    <div class="page page-stats">
      <h2 class="stats-heading">Model Usage Stats</h2>

      <!-- Summary row -->
      <div class="stats-summary card" data-summary></div>

      <!-- Time range info -->
      <p class="stats-timespan" data-timespan></p>

      <!-- Models still in the configuration -->
      <div class="card stats-table-wrap" data-active-wrap>
        <h3 class="stats-table-title">Active Models<span class="muted stats-table-count" data-active-count></span></h3>
        <table class="stats-table">
          ${theadHtml}
          <tbody data-active-body></tbody>
        </table>
      </div>

      <!-- Usage history for models no longer configured -->
      <div class="card stats-table-wrap" data-inactive-wrap>
        <h3 class="stats-table-title">Inactive Models<span class="muted stats-table-count" data-inactive-count></span></h3>
        <p class="muted stats-table-hint">Usage history for models no longer in the configuration.</p>
        <table class="stats-table">
          ${theadHtml}
          <tbody data-inactive-body></tbody>
        </table>
      </div>
    </div>
  `);

  const summaryEl = root.querySelector("[data-summary]");
  const timespanEl = root.querySelector("[data-timespan]");
  const theads = [...root.querySelectorAll("thead")];
  const activeWrap = root.querySelector("[data-active-wrap]");
  const activeBody = root.querySelector("[data-active-body]");
  const activeCountEl = root.querySelector("[data-active-count]");
  const inactiveWrap = root.querySelector("[data-inactive-wrap]");
  const inactiveBody = root.querySelector("[data-inactive-body]");
  const inactiveCountEl = root.querySelector("[data-inactive-count]");

  let sortKey = "requests";
  let sortOrder = "desc";
  let loaded = false;
  let stats = { totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null, models: [], pricing: null };
  // Model ids (plus aliases) present in the running configuration. Empty
  // when the listing is unavailable — then every row counts as active.
  let activeIds = new Set();

  // Display currency and conversion rate: UI settings override the server
  // config snapshot that arrives with the stats payload.
  function effectiveCurrency() {
    return currencyPref.get() || stats.pricing?.currency || "USD";
  }

  function effectiveInrPerUsd() {
    const v = Number(inrPerUsdPref.get());
    if (Number.isFinite(v) && v > 0) return v;
    return stats.pricing?.usd_to_inr || 95;
  }

  function formatCount(n) {
    if (compactNumbers.get()) return formatCompactNumber(n);
    return nf.format(n);
  }

  /** Full-value tooltip content for compact cells; "" when not compact. */
  function countTitle(n) {
    return compactNumbers.get() && Number.isFinite(n) ? ` title="${nf.format(n)} tokens"` : "";
  }

  function modelCost(s) {
    const rates = resolveRates(s.model, stats.pricing, defaultRatesPref.get());
    return estimateCostUSD(s, rates);
  }

  async function fetchStats() {
    try {
      // The backend aggregates over the whole activity log (SQL GROUP BY);
      // the response shape is store.ActivityStats plus the server's pricing
      // snapshot from /api/metrics/stats.
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
        pricing: stats.pricing || null,
      };
    } catch (err) {
      console.error("Failed to fetch stats:", err);
      return { totalRequests: 0, totalInput: 0, totalOutput: 0, totalCached: 0, firstTime: null, lastTime: null, models: [], pricing: null };
    }
  }

  /** Current model ids + aliases. The /v1/models listing is fetched once;
   *  the live SSE store (which also covers unlisted models the listing
   *  omits) is unioned in on every recompute. */
  let listedIds = new Set();

  function recomputeActiveIds() {
    activeIds = new Set(listedIds);
    for (const m of models.get()) {
      activeIds.add(m.id);
      for (const a of m.aliases ?? []) activeIds.add(a);
    }
  }

  async function fetchActiveIds() {
    try {
      const resp = await fetch("/v1/models");
      if (resp.ok) {
        const body = await resp.json();
        listedIds = new Set();
        for (const m of body.data ?? []) {
          listedIds.add(m.id);
          for (const a of m.meta?.llamaswap?.aliases ?? []) listedIds.add(a);
        }
      }
    } catch (err) {
      console.error("Failed to fetch model list:", err);
    }
    recomputeActiveIds();
  }

  function renderSummary(stats) {
    if (stats.totalRequests === 0) {
      summaryEl.innerHTML = `<div class="stats-summary-empty">No metrics recorded yet.</div>`;
      return;
    }

    const costTile = showCost.get()
      ? (() => {
          const totalUSD = stats.models.reduce((sum, s) => sum + modelCost(s), 0);
          const cur = effectiveCurrency();
          const amount = formatCost(totalUSD, cur, effectiveInrPerUsd());
          return `
        <div class="stats-stat">
          <span class="stats-stat-value">${amount}</span>
          <span class="stats-stat-label">Est. Cost</span>
        </div>`;
        })()
      : "";

    summaryEl.innerHTML = `
      <div class="stats-summary-inner">
        <div class="stats-stat">
          <span class="stats-stat-value">${formatCount(stats.totalRequests)}</span>
          <span class="stats-stat-label">Requests</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${formatCount(stats.totalInput)}</span>
          <span class="stats-stat-label">Input Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${formatCount(stats.totalOutput)}</span>
          <span class="stats-stat-label">Output Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${formatCount(stats.totalCached)}</span>
          <span class="stats-stat-label">Cached Tokens</span>
        </div>
        <div class="stats-stat">
          <span class="stats-stat-value">${nf.format(stats.models.length)}</span>
          <span class="stats-stat-label">Models Used</span>
        </div>${costTile}
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
      case "cost": return modelCost(s);
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

  function rowHtml(s, cur, ratio, cost) {
    const costCell = cost
      ? `<td class="stats-td stats-td-num">${formatCost(modelCost(s), cur, ratio)}</td>`
      : "";
    return `<tr class="stats-tr">
      <td class="stats-td stats-td-model">${escapeHtml(s.model)}</td>
      <td class="stats-td stats-td-num"${countTitle(s.requests)}>${formatCount(s.requests)}</td>
      <td class="stats-td stats-td-num"${countTitle(s.input_tokens)}>${formatCount(s.input_tokens)}</td>
      <td class="stats-td stats-td-num"${countTitle(s.output_tokens)}>${formatCount(s.output_tokens)}</td>
      <td class="stats-td stats-td-num"${countTitle(s.cached_tokens)}>${s.cached_tokens > 0 ? formatCount(s.cached_tokens) : "—"}</td>
      <td class="stats-td stats-td-num">${formatSpeed(s.avg_prompt_speed)}</td>
      <td class="stats-td stats-td-num">${formatSpeed(s.avg_gen_speed)}</td>
      <td class="stats-td stats-td-num">${formatDuration(s.total_duration_ms, s.requests)}</td>
      <td class="stats-td stats-td-num">${s.last_used ? formatRelativeTime(s.last_used) : "—"}</td>${costCell}
    </tr>`;
  }

  function renderTable(stats) {
    const cost = showCost.get();
    const cols = cost ? 10 : 9;

    if (stats.totalRequests === 0) {
      activeBody.innerHTML = `<tr><td class="stats-empty" colspan="${cols}">No activity recorded</td></tr>`;
      inactiveWrap.style.display = "none";
      activeCountEl.textContent = "";
      inactiveCountEl.textContent = "";
      renderHeader(cost);
      renderSortIndicator();
      return;
    }

    const cur = effectiveCurrency();
    const ratio = effectiveInrPerUsd();
    const sorted = [...stats.models].sort(compareRows);
    const isActive = (s) => activeIds.size === 0 || activeIds.has(s.model);
    const active = sorted.filter(isActive);
    const inactive = sorted.filter((s) => !isActive(s));

    activeBody.innerHTML = active.length
      ? active.map((s) => rowHtml(s, cur, ratio, cost)).join("")
      : `<tr><td class="stats-empty" colspan="${cols}">No activity recorded</td></tr>`;
    activeCountEl.textContent = ` (${active.length})`;

    if (inactive.length) {
      inactiveWrap.style.display = "";
      inactiveBody.innerHTML = inactive.map((s) => rowHtml(s, cur, ratio, cost)).join("");
      inactiveCountEl.textContent = ` (${inactive.length})`;
    } else {
      inactiveWrap.style.display = "none";
      inactiveCountEl.textContent = "";
    }
    renderHeader(cost);
    renderSortIndicator();
  }

  // renderHeader keeps the Est. Cost column in sync with the showCost
  // preference in both tables without rebuilding the table elements.
  function renderHeader(cost) {
    for (const thead of theads) {
      const existing = thead.querySelector('th[data-sort="cost"]');
      if (cost && !existing) {
        const th = document.createElement("th");
        th.className = "stats-th stats-th-num stats-th-sortable";
        th.dataset.sort = "cost";
        th.innerHTML = `Est. Cost<span class="stats-sort-ind"></span>`;
        thead.querySelector("tr").appendChild(th);
      } else if (!cost && existing) {
        existing.remove();
        if (sortKey === "cost") {
          sortKey = "requests";
          sortOrder = "desc";
        }
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Sorting works on both tables: either header row drives the shared sort
  // state, so matching rows stay aligned across the two lists.
  root.addEventListener("click", (e) => {
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

  Promise.all([fetchStats(), fetchActiveIds()]).then(([fetched]) => {
    stats = fetched;
    loaded = true;
    renderSummary(stats);
    renderTimespan(stats.firstTime, stats.lastTime, stats.totalRequests, stats.models.length);
    renderTable(stats);
  });

  // Re-render live when the configured model set changes (SSE modelStatus),
  // so a model removed mid-session moves to Inactive without a reload. The
  // /v1/models listing is not refetched — the SSE ids are merged into the
  // cached set.
  function refresh() {
    if (!loaded) return;
    recomputeActiveIds();
    renderTable(stats);
  }

  // Re-render live when display preferences change (edited on the Settings
  // page or toggled while this page is open in another tab).
  const subs = [
    compactNumbers.subscribe(() => {
      renderSummary(stats);
      renderTable(stats);
    }),
    showCost.subscribe(() => {
      renderSummary(stats);
      renderTable(stats);
    }),
    models.subscribe(refresh),
  ];

  return {
    el: root,
    destroy() {
      cleanupAll(subs);
    },
  };
}
