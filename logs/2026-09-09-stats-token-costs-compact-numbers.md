# 2026-09-09 — Stats page: token cost estimates + compact numbers

## Goal

Two `/ui/#/stats` requests from the user:

1. Add an "approximate cost of tokens" column to the summary/table — design
   to be brainstormed.
2. Optionally compress large counts to M/B/T suffixes via a settings value.

## Design decisions (brainstormed with the user)

- **Pricing source**: config `pricing:` block (backend, validated) **plus**
  per-browser UI overrides in Settings. Models without pricing fall back to
  defaults; the cost feature can be switched off in Settings.
- **Currency**: USD default, INR alternate; INR-per-USD ratio configurable in
  config (default 95) and overridable in the UI.
- **Formula**: cached tokens are a subset of the prompt in llama.cpp, so
  `cost = ((input − cached)×input_rate + cached×cached_rate +
  output×output_rate) / 1e6`; omitted cached rate → cached bills at the
  input rate.
- **Display**: adaptive precision with `~` prefix (`~$12.34`, `~$0.0042`,
  `~$<0.0001`, `—` for zero/unconfigured).
- **Compact numbers**: Stats page only, M/B/T from 1e6 up, exact value on
  hover.

## Change

Backend:

- `internal/config/pricing.go` (new) — `PricingRates`/`PricingConfig` +
  validation/normalization; `DefaultUSDToINR = 95`.
- `internal/config/model_config.go` — `ModelConfig.Pricing *PricingRates`.
- `internal/config/load.go` — validate pricing (top-level + per-model).
- `internal/server/apipricing.go` (new) — `APIPricing` snapshot;
  `GET /api/metrics/pricing` (registered in `server.go`); stats handler
  (`apigroup.go`) now embeds `pricing` in the `/api/metrics/stats` response.
- `config-schema.json` — `pricingRates` definition, root + model `pricing`.
- `docs/config.example.yaml` — pricing docs (flows into the MCP doc agent;
  `golden_test.go` section list updated).

Frontend (hand-authored ES modules, no build step):

- `js/util/format.js` — `formatCompactNumber`, `formatMoney`.
- `js/util/pricing.js` (new) — `resolveRates`, `estimateCostUSD`,
  `formatCost` (currency conversion), rate precedence helpers.
- `js/preferences.js` (new) — persistent stores: `stats-compactNumbers`,
  `stats-showCost`, `stats-currency`, `stats-inrPerUsd`,
  `stats-defaultRates`.
- `js/pages/stats.js` — sortable Est. Cost column + summary tile (both
  conditional on `showCost`), compact counts with `title` tooltips, live
  re-render on pref changes, subscription cleanup.
- `js/pages/settings.js` — "Stats page" card: compact toggle, cost toggle,
  currency segmented (Auto/USD/INR), INR-per-USD input, default-rate inputs
  with server-default placeholders (from `/api/metrics/pricing`).
- `css/newpages.css` — number-input + rates-row styles.

## Commands

- `go test ./internal/config/ ./internal/server/ ./internal/docagent/` → ok
- `make test-dev` → all packages ok (staticcheck binary absent in env)
- `make gosec` → 0 issues
- `aidc-scan` → clean
- `bun build --no-bundle` per touched JS module → OK (bun lives at
  `~/.bun/bin`, PATH needed the extension)
- `bun /tmp/opencode/pricing-selftest.js` → ALL PASS
- E2E: `go build -o /tmp/opencode/llama-swap .` then run with a priced
  config; `curl /api/metrics/pricing`, `/api/metrics/stats` (chat completion
  recorded → per-model row + pricing snapshot), `/ui/js/...` → 200.

## Verification

Unit tests (`TestConfig_Pricing*`, `TestServer_APIMetricsPricing*`,
`TestServer_APIMetricsStats_IncludesPricing`), JS selftest for precedence +
cost math + formatting, full dev suite, gosec, aidc-scan, and a live
end-to-end check. All green.

## Notes

- Two bugs caught before landing: (1) `renderHeader()` queried an attribute
  it never set → duplicate cost columns on re-render; (2) an omitted model
  `cached` rate inherited the server default instead of billing at the
  model's input rate.
- Go's `*float64` marshals unset `cached` as JSON `null`, which is exactly
  the "bill at input rate" semantics — no tri-state needed.
- Removed the pre-existing dead `loading` flag in `stats.js`.
- Follow-ups (not in scope): per-model rate overrides from the Settings UI,
  live-refresh of stats data (page currently fetches on mount only).
