// Settings page: theme mode, models-page options, stats display options, and
// build information. Ported from routes/Settings.svelte (accent themes
// omitted: this UI's theme system has light/dark/system modes only).
import { el, cleanupAll } from "../dom.js";
import { themeMode, connectionState } from "../theme.js";
import { versionInfo } from "../api.js";
import { persistent } from "../store.js";
import {
  compactNumbers,
  currencyPref,
  defaultRatesPref,
  inrPerUsdPref,
  showCost,
} from "../preferences.js";

const MODES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const CURRENCIES = [
  { value: "", label: "Auto" },
  { value: "USD", label: "USD" },
  { value: "INR", label: "INR" },
];

const RATE_FIELDS = [
  { key: "input", label: "In" },
  { key: "output", label: "Out" },
  { key: "cached", label: "Cached" },
];

// Fetch the server's pricing snapshot for placeholder values; failure is
// non-fatal (placeholders stay empty).
async function fetchServerPricing() {
  try {
    const resp = await fetch("/api/metrics/pricing");
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export function SettingsPage() {
  const showCapabilityTags = persistent("showCapabilityTags", true);

  const root = el(`
    <div class="page page-settings">
      <div class="page-heading"><h2 class="page-title">Settings</h2></div>

      <div class="card settings-card">
        <h3 class="settings-card-title">Appearance</h3>
        <div class="settings-row">
          <span class="settings-label">Theme</span>
          <div class="settings-segmented" data-mode-seg></div>
        </div>
      </div>

      <div class="card settings-card">
        <h3 class="settings-card-title">Models page</h3>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">Show capability tags</span>
            <p class="muted settings-hint">Show all capability badges next to each model, mirroring the
            Details tab (vision, tools, context window, and more).</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" data-caps-toggle />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
      </div>

      <div class="card settings-card">
        <h3 class="settings-card-title">Stats page</h3>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">Compact large numbers</span>
            <p class="muted settings-hint">Compress token and request counts to M/B/T suffixes
            (e.g. 1.23M). Hover a value to see the exact number.</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" data-compact-toggle />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">Show approximate cost</span>
            <p class="muted settings-hint">Estimate token costs on the stats page using the
            server's pricing configuration, overridden by the rates below.</p>
          </div>
          <label class="settings-switch">
            <input type="checkbox" data-cost-toggle />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">Currency</span>
            <p class="muted settings-hint">Auto follows the server's pricing.currency setting.</p>
          </div>
          <div class="settings-segmented" data-currency-seg></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">INR per USD</span>
            <p class="muted settings-hint" data-ratio-hint>Conversion rate applied when the display
            currency is INR.</p>
          </div>
          <input class="settings-number-input" type="number" step="any" min="0" data-ratio-input />
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <span class="settings-label">Default rates (USD per 1M tokens)</span>
            <p class="muted settings-hint">Used for models without their own pricing block;
            blank fields follow the server's pricing.defaults.</p>
          </div>
          <div class="settings-rates-row" data-rates-row></div>
        </div>
      </div>

      <div class="card settings-card">
        <h3 class="settings-card-title">Build Information</h3>
        <dl class="hw-dl" data-build-dl></dl>
      </div>
    </div>
  `);

  const modeSeg = root.querySelector("[data-mode-seg]");
  const capsToggle = root.querySelector("[data-caps-toggle]");
  const compactToggle = root.querySelector("[data-compact-toggle]");
  const costToggle = root.querySelector("[data-cost-toggle]");
  const currencySeg = root.querySelector("[data-currency-seg]");
  const ratioInput = root.querySelector("[data-ratio-input]");
  const ratioHint = root.querySelector("[data-ratio-hint]");
  const ratesRow = root.querySelector("[data-rates-row]");
  const buildDl = root.querySelector("[data-build-dl]");

  function renderModes() {
    const current = themeMode.get();
    modeSeg.innerHTML = MODES.map(
      (m) =>
        `<button class="settings-seg-btn ${m.value === current ? "active" : ""}" data-mode="${m.value}">${m.label}</button>`
    ).join("");
  }

  modeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    themeMode.set(btn.getAttribute("data-mode"));
  });

  capsToggle.checked = showCapabilityTags.get();
  capsToggle.addEventListener("change", () => showCapabilityTags.set(capsToggle.checked));

  compactToggle.checked = compactNumbers.get();
  compactToggle.addEventListener("change", () => compactNumbers.set(compactToggle.checked));

  costToggle.checked = showCost.get();
  costToggle.addEventListener("change", () => showCost.set(costToggle.checked));

  function renderCurrencySeg() {
    const current = currencyPref.get();
    currencySeg.innerHTML = CURRENCIES.map(
      (c) =>
        `<button class="settings-seg-btn ${c.value === current ? "active" : ""}" data-currency="${c.value}">${c.label}</button>`
    ).join("");
    // The ratio only affects INR display; "Auto" may still resolve to INR
    // via the server config, so only USD disables it.
    ratioInput.disabled = current === "USD";
  }

  currencySeg.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-currency]");
    if (!btn) return;
    currencyPref.set(btn.getAttribute("data-currency"));
  });

  function syncRatioInput() {
    const v = Number(inrPerUsdPref.get());
    ratioInput.value = Number.isFinite(v) && v > 0 ? v : "";
  }

  ratioInput.addEventListener("change", () => {
    const v = Number(ratioInput.value);
    inrPerUsdPref.set(Number.isFinite(v) && v > 0 ? v : 0);
  });

  // Default rates row: one numeric input per field; blank = follow server.
  function ratePlaceholder(field, serverPricing) {
    const serverDefaults = serverPricing?.defaults ?? {};
    if (field.key === "cached") {
      const cached = serverDefaults.cached;
      if (cached == null) return serverDefaults.input != null ? `≈ ${serverDefaults.input}` : "auto";
      return String(cached);
    }
    return serverDefaults[field.key] != null ? String(serverDefaults[field.key]) : "";
  }

  function renderRatesRow(serverPricing) {
    const current = defaultRatesPref.get() ?? {};
    ratesRow.innerHTML = RATE_FIELDS.map((f) => {
      const v = current[f.key];
      return `<label class="settings-rates-field">${f.label}
        <input class="settings-number-input" style="width:4.5rem" type="number" step="any" min="0"
          data-rate="${f.key}" placeholder="${ratePlaceholder(f, serverPricing)}"
          value="${v != null ? v : ""}" />
      </label>`;
    }).join("");
  }

  ratesRow.addEventListener("change", (e) => {
    const input = e.target.closest("[data-rate]");
    if (!input) return;
    const key = input.getAttribute("data-rate");
    // Blank or invalid input falls back to the server defaults (null).
    const raw = input.value.trim();
    const num = raw === "" ? null : Number(raw);
    const value = num != null && Number.isFinite(num) && num >= 0 ? num : null;
    defaultRatesPref.set({ ...defaultRatesPref.get(), [key]: value });
  });

  fetchServerPricing().then((serverPricing) => {
    renderRatesRow(serverPricing);
    if (serverPricing?.usd_to_inr) {
      ratioHint.textContent = `Conversion rate applied when the display currency is INR. Server default: ${serverPricing.usd_to_inr}.`;
    }
  });

  function renderBuild() {
    const conn = connectionState.get() ?? "unknown";
    const v = versionInfo.get() ?? {};
    buildDl.innerHTML = [
      ["Event Stream", conn],
      ["Version", v.version ?? "unknown"],
      ["Commit Hash", (v.commit ?? "unknown").substring(0, 7)],
      ["Build Date", v.build_date ?? "unknown"],
    ]
      .map(([k, val]) => `<dt class="hw-dt">${k}</dt><dd class="hw-dd">${String(val)}</dd>`)
      .join("");
  }

  const subs = [
    themeMode.subscribe(renderModes),
    connectionState.subscribe(renderBuild),
    versionInfo.subscribe(renderBuild),
    currencyPref.subscribe(renderCurrencySeg),
    inrPerUsdPref.subscribe(syncRatioInput),
  ];

  renderModes();
  renderBuild();
  renderCurrencySeg();
  syncRatioInput();
  renderRatesRow(null);

  return {
    el: root,
    destroy() {
      cleanupAll(subs);
    },
  };
}
