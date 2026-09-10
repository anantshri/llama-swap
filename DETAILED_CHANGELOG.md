# Detailed Changelog

Long-form, dated entries — what / why / how / verification — newest first.
High-level summaries live in [CHANGELOG.md](CHANGELOG.md).

---

## 2026-09-10 — config: fix TestConfig_LoadWindows after pricing defaults

### Symptom

GitHub Actions Windows runner failed `make test-all` with
`TestConfig_LoadWindows` (internal/config/config_windows_test.go:293):
the loaded `Config` had `Pricing{Currency:"USD", USDToINR:95}` while the
test expected the zero value `{Currency:"", USDToINR:0}`.

### Diagnosis

The pricing feature (Stats-page cost estimates) added normalization in
`PricingConfig.Validate()` (internal/config/pricing.go): an unset
`currency` becomes `USD` and a zero `usdToINR` becomes
`DefaultUSDToINR` (95). `TestConfig_LoadPosix` — the `!windows` twin —
was updated with the normalized `Pricing` block in its expected
`Config`, but the `//go:build windows` copy was not. The file only
compiles on Windows, so Linux dev/CI never caught the staleness; only
the Windows leg of the GitHub Actions matrix did.

### Change

- `internal/config/config_windows_test.go`: added the same expected
  `Pricing: PricingConfig{Currency: "USD", USDToINR: DefaultUSDToINR}`
  to `TestConfig_LoadWindows`'s expected struct, in the same position
  as the posix test (between `Upstream` and `Routing`).

Test-only change; no production code touched.

### Commands

- `GOOS=windows go test -c -o /dev/null ./internal/config` — compiles
  (the test cannot execute on Linux; compilation is the available check)
- `go test -race -count=1 ./internal/config/` — ok
- `gofmt -l internal/config/` — clean
- `make test-all` — ok (full race suite)
- `make gosec` / `aidc-scan` — see session log

### Verification

Windows CI is the only place the test runs; the compile check plus the
byte-identical expected block to the passing posix twin (which asserts
the same normalization path through `Load`) give confidence the Windows
run is green again.

### Notes

Follow-up to the pricing commit ("stats shananigans", 79ac1a0). The
other Windows-only test files (internal/hw/hardware_windows_test.go,
internal/perf/d3dkmt_windows_test.go, internal/perf/pdh_windows_test.go)
do not compare `Config` structs and are unaffected.


### Symptom

After deploying the xpu-smi probe to dumbo, the Hardware page showed the
Arc Pro B70 with `31.9 GiB (Dedicated)` but **Architecture: Not detected**
and **Power Limit: Not detected** — both had worked before the change.

### Diagnosis

Two independent defects:

1. **Regression (the important one):** the xpu-smi refactor introduced
   `detectDRMSysfsFrom(sysRoot)` and rewired the render-node check to
   `filepath.Join(sysRoot, "dev", "dri")` → `/sys/dev/dri`, which does not
   exist — render nodes live at `/dev/dri`, a different hierarchy from
   sysfs. `hasAccessibleRenderNode` therefore failed for every card on a
   real host and `detectDRMSysfs` returned nothing, losing the sysfs
   record that supplied architecture (PCI-ID table), power limit, and
   driver-module name. The unit test missed it because its fixture
   created `renderD128` under the temp sysfs root's own `dev/dri`,
   mirroring the wrong path.
2. **Classification gaps (pre-existing):** `intelModelByID` had B50/B60
   swapped (`0xE211` is B60, `0xE212` is B50 per pci.ids) and no entries
   for the Battlemage G31 dies (`0xE222` Arc Pro B65, `0xE223` Arc Pro
   B70) — although both G31 IDs were already in the architecture table,
   so sysfs-side architecture for the B70 worked before the regression.

### Change

- `internal/hw/detect_linux.go`: `detectDRMSysfsFrom(sysfsRoot, driRoot)`
  takes **two** roots; production wiring passes `/sys` and `/dev/dri`.
  A comment records that the hierarchies are distinct.
- `internal/hw/intel_linux_test.go`: the sysfs fixture uses disjoint temp
  directories for the sysfs tree and the DRI tree, so joining them under
  one root fails the test (this is the guard that was missing).
- `internal/hw/intel_linux.go`: the xpu-smi record now maps
  `pci_device_id` through `intelGPU()` to fill Architecture (and a model
  fallback), so it is populated even where sysfs is unavailable; the
  driver name is inferred from the branded version prefix (`I915_` →
  i915, `XE_` → xe) instead of being hardcoded `xe` (wrong for i915
  Flex cards) — bare versions like dumbo's `17012946` leave the name for
  sysfs to fill.
- `internal/hw/intel.go`: Battlemage comment split G21/G31; model table
  fixed — `0xE211` Arc Pro B60, `0xE212` Arc Pro B50, `0xE222` Arc Pro
  B65, `0xE223` Arc Pro B70 (verified against the pci.ids database and
  torvalds/linux `include/drm/intel/pciids.h`).

### Tests

- Fixture test now proves a card is detected with render nodes in a root
  disjoint from sysfs (fails under the `/sys/dev/dri` bug).
- `TestHardware_IntelXPUSMIB70`: dumbo's exact record — Battlemage from
  `0xE223`, nil driver name for a bare numeric version, 32 GiB dedicated.
- `TestHardware_IntelXPUSMII915DriverName`: I915_ prefix infers i915.
- `TestIntelGPU_DiscreteWithModel` / `BattlemageArchOnly` updated for the
  corrected B50/B60 and new B65/B70 entries.
- Merge test rebuilt to use a no-`pci_device_id` fixture so it still
  proves the sysfs record contributes architecture and driver name.

### Commands

- `go test -run "TestHardware_Intel|TestIntelGPU" ./internal/hw/` — 14 passed.
- `make test-dev` — all packages ok (go test + staticcheck).
- `make gosec` — 0 issues (linux, darwin, windows).
- `aidc-scan` — clean.

### Notes

Lesson recorded: a fixture that mirrors the code's (wrong) path
convention instead of the real filesystem layout passes while production
breaks — fixture layouts for path-based code should be modeled on the
real host hierarchy, and refactors that parameterize hardcoded paths
need extra suspicion when the paths span different filesystem roots.

---

## 2026-09-09 — hw: Intel dGPU VRAM via xpu-smi (was "Shared System")

### Symptom

On the dumbo server (Intel graphics), the Hardware page showed the GPU's
memory as `Shared System` with no capacity, while `xpu-smi` on that host
correctly reports 32 GB of VRAM.

### Diagnosis

`internal/hw/detect_linux.go` `detectDRMSysfs` classifies every DRM device
without a readable `mem_info_vram_total` sysfs file as `shared_system`. On
this host the Intel driver stack does not expose that file for the card, so
the discrete GPU fell into the integrated-GPU bucket. NVIDIA and AMD each
have a CLI probe (`nvidia-smi`, `rocm-smi`) that merges over the sysfs
record by PCI identity — Intel had none; only the PCI-ID architecture/model
table in `intel.go`.

### Change

- `internal/hw/intel_linux.go` (new): `detectIntel` probe using
  `xpu-smi discovery -j` to list devices, then `xpu-smi discovery -d <id> -j`
  per device for full detail (the bare listing omits memory). Maps
  `memory_physical_size_byte` to `dedicated` capacity; a `device_type`
  containing "integrated" keeps `shared_system`. Merges with the sysfs
  record via normalized PCI BDF (`normalizePCIIdentity`), so sysfs still
  contributes architecture (e.g. Alchemist/Battlemage from the PCI-ID
  table) and power limits where xpu-smi's record is thinner.
- `internal/hw/detect_linux.go`: `detectPlatform` runs `detectIntel` after
  AMD and before sysfs (merge order: existing non-null value wins, so the
  authoritative CLI probe must come first — same pattern as NVIDIA/AMD).
  `detectDRMSysfs` refactored to `detectDRMSysfsFrom(sysRoot)` and
  `hasAccessibleRenderNode(devicePath, deviceRoot)` now takes roots, making
  the sysfs path testable off the live `/sys`.
- Driver name in the xpu-smi record is `xe` with xpu-smi's
  `driver_version` string (that string is driver-branded, e.g.
  `XE_1.0.4_...` / `I915_...`).

gosec G204 on the `xpu-smi` invocation is suppressed inline (fixed binary +
integer device id, same pattern as `nvidia-smi`/`rocm-smi` calls); ledger
`docs/gosec-suppressions.md` updated (G204 ×8, total 92).

### Tests

`internal/hw/intel_linux_test.go` (new, captured-JSON parser tests, no
local hardware needed):

- Flex 170 detail JSON → dedicated + 14942253056 bytes + driver version.
- `device_type: "Integrated GPU"` stays `shared_system`.
- Missing memory fields → dedicated without invented capacity.
- BDF normalization of xpu-smi's domain-qualified form.
- `detectIntel` returns nil without xpu-smi on PATH.
- Merge test: xpu-smi `dedicated`+capacity wins over a sysfs
  `shared_system` record for the same PCI address, sysfs architecture
  preserved.
- Sysfs fixture test (`detectDRMSysfsFrom`): `mem_info_vram_total`
  present → dedicated (regression guard for the pure-sysfs path), ATS-M
  device ID resolves to Alchemist.

### Commands

- `go test -v -run "TestHardware_Intel" ./internal/hw/` — 7 passed.
- `make test-dev` — ok (go test + staticcheck).
- `make gosec` — 0 issues (linux, darwin, windows).
- `go test -cover ./...` — 1501 passed in 31 packages.
- `aidc-scan` — clean.

### Verification notes

- Live verification on dumbo requires the rebuilt binary on that host;
  expected result: Flex/Arc card shows `Dedicated` with ~32 GB (xpu-smi's
  `memory_physical_size_byte`).
- xpu-smi JSON field names verified against intel/xpumanager source
  (`ial/cmn/cmd_discovery.cpp`): listing uses `device_list[].device_id` /
  `pci_bdf_address`; per-device detail uses `device_name`, `device_type`
  ("Discrete GPU" / "Integrated GPU"), `driver_version`, and
  `memory_physical_size_byte` (bytes, promoted to a JSON number).

---

## 2026-09-09 — UI: populate Build Information (was always "unknown")

### Symptom

The Settings page's "Build Information" card (and the header connection
tooltip) showed `unknown` for Version, Commit Hash, and Build Date, even
though `GET /api/version` returns correct values and the binary is built
with `-ldflags -X main.version/main.commit/main.date` (Makefile).

### Diagnosis

The UI's `versionInfo` store (`ui_dist/js/api.js`) was initialized to
`"unknown"` placeholders and never updated: no code fetched `/api/version`,
and the SSE event stream (`handleAPIEventMessage`) has no version event.
The Settings page and header subscribe to the store, so they rendered the
initial placeholders forever. The store was ported from the old Svelte UI
(`stores/api.ts`) but the code that populated it was lost in the port.

### Change

- `internal/server/ui_dist/js/api.js`: new `fetchVersionInfo()` — fetches
  `GET /api/version` once and populates `versionInfo`, keeping "unknown"
  defaults on HTTP error or network failure (non-fatal).
- `internal/server/ui_dist/js/main.js`: calls `fetchVersionInfo()` at boot,
  right after `enableAPIEvents(true)`.

Also removed `max-width: 34rem` from `.page-settings`
(`ui_dist/css/newpages.css`) so the Settings page uses the full content
width (per user request in the same session).

### Commands

- `go test -short ./internal/server/` — 365 passed (covers UI
  serving/embedding via `internal/server/ui_test.go`).
- `aidc-scan` — clean.

### Verification

Rebuilding and loading the UI now fills the Build Information card from
`/api/version`; on a server built with plain `go build` (no ldflags) it
will show the compile-time defaults (`0` / `abcd1234` / `unknown`) rather
than a fetch failure.

### Notes

- `node` is not available in this container, so the modified ES modules
  were syntax-checked by review only; browser loading is exercised by the
  existing UI serving tests only at the HTTP layer.

---

## 2026-09-09 — Port upstream #1075: set-if-undefined params via `?` key suffix

### What / goal

Surveyed the 12 upstream commits since this fork's baseline (`7a14664`) and
the user picked the port of upstream PR #1075 (fixes upstream issue #1052):
a `setParams`/`setParamsByID` key ending in `?` (e.g. `max_tokens?: 4096`)
is **set-if-undefined** — applied only when the request does not already
carry that parameter. Plain keys keep forcing their values; a config that
never uses the suffix behaves exactly as before.

### Porting notes (why not a cherry-pick)

Upstream's `filters.go` lacks this fork's `SetParamsByMatch` (upstream PR
#934 was never merged upstream; the fork carries its own implementation), so
the patch was merged by hand:

- `internal/config/filters.go` — refactored `SanitizedSetParams` /
  `SanitizedSetParamsByID` to delegate to a shared `sanitizeParams()`
  (upstream's refactor, which also de-duplicates the fork's copies) returning
  `(params, keys, soft)` where `soft` marks `?`-spelled keys (suffix
  stripped). Hard spelling wins when both `key` and `key?` exist; `model?`
  stays protected; a bare `?` key is ignored; `soft` is nil when empty.
- `internal/server/filters.go` — `applyFilters` skips a soft key when
  `gjson.GetBytes(body, key).Exists()` at its pipeline stage. The fork's
  pipeline is `stripParams | setParamsByMatch | setParams | setParamsByID`
  (upstream has no byMatch stage), so a stripped key counts as undefined and
  a key set by an earlier stage (byMatch rule or setParams) counts as
  defined.
- `MatchRule.SanitizedSet()` (fork-only feature) intentionally unchanged —
  upstream scope covers `setParams`/`setParamsByID` only.

### Docs

- `config-schema.json`: `?` suffix documented in model `setParams`,
  `setParamsByID`, and peer `setParams` descriptions.
- `docs/config.example.yaml`: model + peer `setParams` comments and a
  `max_tokens?: 4096` example (feeds the MCP doc agent automatically).
- `docs/kb/guides/api-integration/set-if-undefined.md` (new, adapted to name
  the fork's byMatch stage in the pipe order).
- `docs/kb/guides/api-integration/filters-and-request-rewriting.md`:
  set-if-undefined paragraph, pipe-order note, and the Order of operations
  list gained the previously missing `setParamsByMatch` step.

### Tests

- `internal/config/filters_test.go`: soft-suffix stripped/reported,
  hard-wins-over-soft, protected param cannot be soft, bare `?` ignored, and
  per-alias `?` cases for both sanitize functions (ported from upstream's
  table additions).
- `internal/server/filters_test.go`: seven new `applyFilters` subtests
  covering applied-when-missing, request-value-wins, `0`/`false`/`null`
  counting as sent, stripped-then-refilled, dotted path keys, byID no-op
  after setParams, and the issue #1052 pipeline example.

### Commands

- `go test ./internal/config/ ./internal/server/ -run "Filters|Filter"` → ok
- `go test ./internal/config/ ./internal/server/ ./internal/docagent/` → ok
- `make test-dev` → all packages ok; `make gosec` → 0 issues
- E2E: ran the binary with `setParams: {temperature: 0.7, max_tokens?: 4096}`
  against the fake responder — a request carrying `max_tokens: 100` kept 100;
  one without gained `max_tokens: 4096`; both got `temperature: 0.7`.

### Verification notes

First `aidc-scan` run after the port flagged 2 gitleaks findings — both the
literal placeholder `nodekey:0123456789abcdef…` from tailcat documentation in
git history (one commit is this fork's since-removed tailcat experiment, one
is upstream's tailcat commit on the fetched `upstream` ref). None exist in
the working tree; `trufflehog filesystem` reports zero secrets. Fingerprints
registered in `.gitleaksignore` following its documented convention, and
`aidc-scan` is clean again.

---

## 2026-09-09 — Stats page: approximate token costs + compact number display

### What / goal

Two Stats-page (`/ui/#/stats`) requests:

1. An "approximate cost of tokens" column alongside the existing totals.
2. Optionally compress large counts to M/B/T suffixes, controlled by a
   setting.

Design brainstormed with the user. Decisions:

- Pricing source: a real `pricing:` config block (validated by the Go config
  loader), **plus** per-browser overrides in the UI Settings page. Models
  without their own pricing fall back to defaults; the cost display can be
  turned off in Settings.
- Currency: USD default, INR alternate, with an INR-per-USD ratio
  configurable both in config (top-level `pricing.usdToINR`, default 95) and
  in the UI.
- Cost formula: cached tokens are a *subset* of prompt tokens in llama.cpp,
  so they are deducted from billable input:
  `(input − cached)×input_rate + cached×cached_rate + output×output_rate`,
  all divided by 1M (rates are $/1M tokens). When a model has no `cached`
  rate, cached tokens bill at the input rate (the OpenAI-style default).
- Cost display: adaptive precision (`~$12.34` ≥ $0.01, four decimals down to
  $0.0001, `<0.0001` below that, `—` for zero/unconfigured).
- Compact numbers scope: Stats page only.

### Change — backend

- `internal/config/pricing.go` (new): `PricingRates` (`input`, `output`,
  optional `cached`, all USD per 1M tokens, `>= 0` validation) and
  `PricingConfig` (top-level `pricing:` section: `currency` USD|INR,
  `usdToINR` default `DefaultUSDToINR = 95`, `defaults PricingRates`).
  `Validate()` normalizes (empty currency → USD, zero ratio → 95).
- `internal/config/model_config.go`: `ModelConfig.Pricing *PricingRates`
  (`yaml:"pricing"`); pointer so "not set" (inherit defaults) is distinct.
- `internal/config/load.go`: validates top-level pricing and every model's
  pricing during load (errors name the model, e.g. `model m1 pricing.output`).
- `internal/server/apipricing.go` (new): `APIPricing` snapshot
  (`currency`, `usd_to_inr`, `defaults`, `models: {modelId: rates}` — only
  models with a pricing block listed) served at `GET /api/metrics/pricing`
  and embedded in the `/api/metrics/stats` response as a `pricing` key (the
  handler now encodes `struct { store.ActivityStats; Pricing APIPricing }`,
  so the existing JSON shape is unchanged apart from the new key). Normalizes
  blank currency/zero ratio so consumers never see a degenerate snapshot.
  No locking needed: `s.cfg` is immutable per Server instance (hot reload
  creates a new Server).
- `internal/config/config-schema.json`: shared `pricingRates` definition,
  root `pricing` property, model-level `pricing` property.
- `docs/config.example.yaml`: documents the top-level `pricing:` section and
  a per-model example (the MCP doc agent indexes this file, so its golden
  section list in `internal/docagent/golden_test.go` gained `pricing`).

### Change — frontend (vanilla ES modules, no build step)

- `js/util/format.js`: `formatCompactNumber()` (3 significant digits with
  M/B/T suffixes from 1e6 up; full locale format below) and `formatMoney()`
  (adaptive precision, `~` prefix, `—` for zero/missing).
- `js/util/pricing.js` (new): `resolveRates()` (model config block is
  authoritative; otherwise UI default rates per field, falling through to
  server defaults), `estimateCostUSD()` (cached-deducted formula),
  `toDisplayCurrency()`/`currencySymbol()`/`formatCost()`.
- `js/preferences.js` (new): `persistent()` stores —
  `stats-compactNumbers` (off), `stats-showCost` (on), `stats-currency`
  ("" = follow server), `stats-inrPerUsd` (0 = follow server),
  `stats-defaultRates` (null fields = follow server).
- `js/pages/stats.js`: sortable `Est. Cost` column (cost header/cells appear
  only when `showCost` is on; `renderHeader()` adds/removes the `th`, the
  colspan tracks 9/10), "Est. Cost" summary tile (sum of per-model costs),
  compact formatting with exact-value `title` tooltips on the four count
  columns, and live re-render on preference changes (subscriptions cleaned
  up in `destroy()`).
- `js/pages/settings.js`: new "Stats page" card — compact-numbers toggle,
  show-cost toggle, currency segmented control (Auto/USD/INR; the INR-rate
  input is disabled only for USD since Auto may resolve to INR), INR-per-USD
  input, and per-field default-rate inputs whose placeholders show the
  server's configured defaults (fetched from `/api/metrics/pricing`).
- `css/newpages.css`: `.settings-number-input`, `.settings-rates-row`,
  `.settings-rates-field`.

### Commands

- `go test ./internal/config/ -run TestConfig_Pricing` → ok
- `go test ./internal/server/ -run "TestServer_APIMetricsPricing|TestServer_APIMetricsStats"` → ok
- `bun build --no-bundle` on every touched JS module → parses/resolves
- `bun /tmp/opencode/pricing-selftest.js` → formatter/cost unit checks ALL PASS
- `make test-dev` → all packages ok (staticcheck binary absent in env)
- `make gosec` → 0 issues across linux/darwin/windows
- `aidc-scan` → semgrep + gitleaks + gosec clean
- End-to-end: built the binary, ran it with a priced config
  (`/tmp/opencode/e2e-config.yaml`), sent one chat completion, confirmed
  `/api/metrics/pricing`, `/api/metrics/stats` (now including `pricing`), and
  the served UI modules (`/ui/js/...` → 200).

### Verification

Backend unit tests cover defaults, valid/invalid YAML (bad currency,
negative ratio/rates), API snapshot shape, stats-embedding, and the
unconfigured fallback. The JS pricing selftest exercises rate precedence
(model config > UI defaults > server defaults), the cached-deduction math
(600k×2.5 + 400k×1.25 + 500k×10 = $7.00/1M), INR conversion (~₹665.00), and
compact/money formatting edge cases. `make test-dev`, `make gosec`, and
`aidc-scan` all clean.

### Notes

- Caught in review: `renderHeader()` initially queried `[data-cost-th]`
  which was never set — the cost column would have been appended on every
  re-render. Fixed to query `th[data-sort="cost"]`.
- Caught by the selftest: an earlier `resolveRates()` let a model's omitted
  `cached` inherit the *server default* cached rate; per the documented
  semantics a model pricing block is authoritative (omitted cached bills at
  the model's input rate), so the fallback chain only applies to models
  without a pricing block.
- JSON cannot distinguish "model pricing omitted `cached`" from
  "`cached: null`" (Go `*float64(nil)` marshals to `null`), which is exactly
  the same meaning here — convenient, not a limitation.
- Pre-existing dead `loading` flag in `stats.js` removed while touching the
  file.

---

## 2026-09-09 — Fix Activity page failing to render rows (`pinningId` scope)

### What / symptom

The `#/activity` table stopped populating after the pin-button change
(2026-09-06): no request rows rendered and captures could not be viewed.
Console showed, once per refresh:

```
activityTable.js:447 Failed to refresh activity: ReferenceError: pinningId is not defined
    at cellHtml (activityTable.js:118:20)
    at renderBody (activityTable.js:329:29)
    at refresh (activityTable.js:443:7)
```

### Why

`8b143d3` added the capture pin/unpin buttons and made `cellHtml` read
`const busy = pinningId === m.id;` when rendering the Capture column.
`cellHtml` is a module-scope helper; `pinningId` is a local of the
`ActivityTable()` closure (used by the click handler), so every row with
`has_capture || pinned` threw a `ReferenceError` mid-`renderBody`. The throw
was swallowed by `refresh()`'s `catch` (logged as "Failed to refresh
activity"), leaving `rows` assigned but the table body empty. Only rows with a
capture triggered it, which is why an empty log looked fine and the breakage
appeared as soon as any capture existed.

### How

- `cellHtml(m, key, loadingCaptureId)` gained a fourth parameter
  `pinningId` (same pattern as `loadingCaptureId`, which the original
  pin change should have followed).
- The single call site in `renderBody` passes it:
  `cellHtml(m, c.key, loadingCaptureId, pinningId)`.
- The click handler keeps using the closure variable — unchanged.

### Commands

- `go test ./internal/server/ -run 'TestUI|TestServe' -count=1` → ok
- `~/.bun/bin/bun build --no-bundle
  internal/server/ui_dist/js/components/activityTable.js` → parses (PATH bun
  shim is broken; use `~/.bun/bin/bun` directly)
- `aidc-scan` → semgrep + gitleaks clean

### Verification

`bun build --no-bundle` parses the module. `rg 'pinningId'` confirms the only
remaining uses are the new parameter, the closure declaration, and the click
handler. Manual check: load `#/activity` with ≥1 capture — rows render, View
opens the capture dialog, pin/unpin still disable their buttons while in
flight (busy state flows through the new parameter).

### Notes
Regression introduced by 8b143d3 (2026-09-06, pin Activity captures).

---

## 2026-09-09 — Sortable Stats page table (folded fork PR #19)

### What

Every column header on the Stats page (Model, Requests, Input/Output/Cached
Tokens, Avg Prompt/Gen Speed, Avg Duration, Last Used) is now clickable to
sort; clicking again toggles ascending/descending. Default remains
requests-descending, matching the previous server-side ordering. Sorting is
client-side over the rows already returned by `/api/metrics/stats`; ties break
by model name.

### Why

anantshri/llama-swap#18 ("the stats page table should be sortable") was
addressed by ai-anant's PR #19. That PR could not be applied as a patch: it was
written against the pre-rebase `stats.js` that fetched
`/api/metrics/activity?limit=999` and aggregated client-side (Maps of
`promptSpeeds` arrays, `toRow`/`compareRows` over aggregated buckets). This
fork's `stats.js` now consumes the server-aggregated `/api/metrics/stats`
payload (snake_case per-model rows), so the PR's *feature* was folded in and
its aggregation helpers dropped.

### How

- `internal/server/ui_dist/js/pages/stats.js`:
  - `<th>` headers gained `stats-th-sortable` + `data-sort` keys
    (`model`, `requests`, `inputTokens`, `outputTokens`, `cachedTokens`,
    `avgPromptSpeed`, `avgGenSpeed`, `avgDuration`, `lastTimestamp`) and a
    `.stats-sort-ind` indicator span — same pattern as `activityTable.js`.
  - `sortKey`/`sortOrder` state (default `requests`/`desc`);
    `sortValue()` maps the camelCase sort keys onto the snake_case server
    fields, with `null` speeds → `-1`, missing `last_used` → `0`, and
    `avgDuration` computed as `total_duration_ms / requests`;
    `compareRows()` applies direction and model-name tie-break;
    `renderSortIndicator()` shows ▲/▼ on the active column.
  - `renderTable` sorts a copy of `stats.models` before rendering (the
    server's array is left untouched) and an `thead` click handler toggles
    key/direction and re-renders.
- `internal/server/ui_dist/css/app.css`: `.stats-th-sortable`
  (pointer cursor + hover color) and `.stats-sort-ind(.active)`
  (dimmed 0.35 → active 1) matching `newpages.css`'s activity equivalents.

### Commands

- `curl -fsSL https://bun.sh/install | bash` (env had no JS engine; pmg shim
  needs the real bun on PATH)
- `bun build --no-bundle internal/server/ui_dist/js/pages/stats.js` → syntax OK
- `go test ./internal/server/` → ok
- `make test-dev` → all packages ok (staticcheck not installed here; no Go
  code changed)
- `aidc-scan` → semgrep + gitleaks clean

### Verification

`bun build --no-bundle` parses the module (equivalent of the PR's
`node --check`). `go test ./internal/server/` covers UI embedding/serving
(`ui_test.go`). Manual check: header click cycles desc → asc, indicator moves
with the active column, empty state still renders.

### Notes

Original PR: https://github.com/anantshri/llama-swap/pull/19 (cc7a865),
issue: https://github.com/anantshri/llama-swap/issues/18.

---

## 2026-09-06 — Pin Activity captures to the sqlite store

### What

The Activity page's Capture column now has a 📌 pin button next to View.
Pinning copies the zstd-compressed CBOR payload from the in-memory capture
cache into a new `pinned_captures` sqlite table, where it survives cache
eviction until the user deletes it by clicking the pinned badge (confirm
dialog). `GET /api/captures/{id}` falls back to the database, so pinned
captures stay viewable indefinitely; activity rows gained a `pinned` field and
`has_capture` now reports "in memory or pinned".

Capture sizing guidance documented alongside: the capture cache budgets
compressed bytes with FIFO eviction; a 6K-token sequence is ~24KB raw /
~3–6KB compressed, so `captureBuffer: 100` retains ~1000 recent captures.

### Why

Captures previously existed only in the fixed-size memory cache — on a busy
proxy a request/response could vanish within minutes, making the Activity
page's View button unreliable for postmortems. Users need a way to keep
specific sequences permanently without growing the memory budget.

### How

- `internal/store/migrations/00002_pinned_captures.sql`: `activity_id`
  (PK, mirrors `activity.id`), `ts_pinned`, `model_id`, `req_path`,
  `data BLOB` (same zstd+CBOR encoding as memory).
- `internal/store/store.go`: `InsertPinnedCapture` (INSERT OR REPLACE, so
  re-pinning refreshes), `GetPinnedCapture` (`sql.ErrNoRows` → not found),
  `DeletePinnedCapture` (no-op on unknown ID), `PinnedCaptureIDs` (full-set
  scan; the table only grows via explicit user action), `GetActivity`
  (single row via the MinID/MaxID filter), and orphan cleanup in
  `PruneActivity` (pins whose activity row was pruned are deleted — only
  reachable in in-memory stores).
- `internal/server/metrics.go`: `overlayCaptureState(ctx, entries)` now also
  loads the pinned-ID set; `Pinned` is set from it and `HasCapture` is true
  when the payload is reachable from either the memory cache or the DB.
- `internal/server/apigroup.go`:
  - `handleAPICapturePin` — compresses the in-memory capture, denormalizes
    `model_id` best-effort via `GetActivity` (a missing row must not block
    pinning), and inserts. 404 when the capture was evicted or captures are
    disabled.
  - `handleAPICaptureUnpin` — deletes the DB row; unpinning unknown IDs is a
    no-op success.
  - `handleAPICapture` — DB fallback (decompress) when the memory cache
    misses, before returning 404.
- `internal/server/server.go`: routes `POST/DELETE /api/captures/{id}/pin`
  behind the same `apiChain` (auth) as the other management endpoints.
- `internal/server/ui_dist/js/`: `api.js` gains `pinCapture`/`unpinCapture`;
  `activityTable.js` renders `View | 📌` in the capture column (grayscale
  until pinned, `window.confirm` before unpin), with a `pinningId` busy state
  and a `refresh()` after the operation so `has_capture`/`pinned` come back
  from the server.
- `internal/server/ui_dist/css/newpages.css`: `.activity-pin-btn` styles
  (actions wrapped in an inline-flex `span` — not the `<td>` — to avoid
  breaking table layout).

### Commands

- `gofmt -w internal/store internal/server`
- `go test -run 'TestStore_PinnedCaptures|TestStore_PruneActivity|TestServer_APICapturePinLifecycle|TestServer_HandleAPICapture' -v ./internal/store/ ./internal/server/` → all pass
- `make test-dev`, `make gosec`, `aidc-scan`, `make test-all` → clean

### Verification

- `TestStore_PinnedCaptures`: empty set initially, not-found reads, insert +
  replace-on-repin, delete + delete-unknown no-op, and file-backed
  persistence across close/reopen (migration 00002 applies on new DBs).
- `TestStore_PruneActivity` (extended): pins on pruned activity rows are
  removed; pins on kept rows survive.
- `TestServer_APICapturePinLifecycle`: pin from memory → clear the memory
  cache (eviction) → GET still returns the payload from the DB (base64
  `req_body` round-trips) → activity row shows `pinned`+`has_capture` →
  unpin → GET 404 and row clears. Pin on evicted capture → 404; non-numeric
  IDs → 400 on both verbs.

### Notes

- Pinning requires the capture to still be in memory (captures enabled,
  non-zero `captureBuffer`); once pinned, captures remain viewable even if
  `captureBuffer` is later reduced or set to 0.
- `req_body`/`resp_body` marshal as base64 in the capture JSON — assertions
  must match the encoded form.
- The memory cache is FIFO, not LRU; eviction order is insertion order.

---


## 2026-09-06 — Stats page aggregates server-side, no more 999-request cap

### What

The Stats page (`#/stats`) previously fetched `/api/metrics/activity?limit=999`
and reduced the rows client-side, so every total silently covered only the most
recent 999 requests. It now renders from `/api/metrics/stats`, whose aggregate
is computed in SQL over the **entire** activity log. The stats endpoint
(`store.ActivityStats`) gained `first_timestamp` / `last_timestamp` and a
per-model `models` breakdown; the UI markup is unchanged.

Related (not changed): request/response captures on the Activity page remain
bounded by the in-memory `captureBuffer` (MB) LRU — captures are never written
to sqlite, so operators wanting more retained captures should raise
`captureBuffer` in their config.yaml.

### Why

- `parseActivityLimit` (internal/server/apigroup.go) hard-caps the activity
  list endpoint at 999 rows, so any client-side aggregation had a 999 ceiling
  that was invisible to users and hit quickly on busy proxies.
- With a file-backed sqlite `store`, activity history is unbounded (pruning
  only runs for in-memory stores), so the full dataset is available for
  aggregation — it just wasn't being used.
- The 999-row fetch also shipped every row's full metadata to the browser only
  to throw most of it away; a single GROUP BY is cheaper on both ends.

### How

- `internal/store/store.go`:
  - New `ActivityModelStats` struct (`model`, `requests`, `input_tokens`,
    `output_tokens`, `cached_tokens`, `avg_prompt_speed`, `avg_gen_speed`,
    `total_duration_ms`, `last_used`). Average speeds are `*float64` — `null`
    when a model never reported that speed — so "no data" stays distinct
    from a real 0.
  - `ActivityStats` extended with `first_timestamp` / `last_timestamp`
    (`*time.Time`, `null` on an empty log) and `models`
    (always a non-nil JSON array, ordered by request count descending then
    model id for stable output).
  - `activityTimeRange`: `SELECT MIN(ts_created), MAX(ts_created)` over the
    same placeholder-built `where` clause.
  - `activityModelStats`: one `GROUP BY model_id` query with
    `AVG(CASE WHEN speed > 0 THEN speed END)` (zero values excluded, matching
    the prior client-side behavior), `SUM(CASE WHEN cache_tokens > 0 ...)`
    for cached tokens, and `MAX(ts_created)` per model.
- `internal/server/apigroup.go`: no handler change — `handleAPIActivityStats`
  already encodes the whole `store.ActivityStats`, so the new fields flow
  through automatically. Additive JSON only; the Activity page's
  `activityStats.js` (which reads `total_requests` + histograms) is unaffected.
- `internal/server/ui_dist/js/pages/stats.js`: `fetchMetrics`/`aggregate`
  replaced by `fetchStats`, which maps the endpoint's snake_case JSON onto the
  existing render functions. Speed formatting treats `null` as "—"; average
  duration still derives from `total_duration_ms / requests`. The 999-cap
  comment and `limit=999` fetch are gone.

### Commands

- `gofmt -w internal/store/store.go internal/store/store_test.go`
- `go test -v -run 'TestStore_ActivityStats|TestServer_APIMetricsStats' ./internal/store/ ./internal/server/` → all pass
- `go test -cover ./internal/store/` → new funcs `activityTimeRange` 90.9%,
  `activityModelStats` 88.9%; the uncovered branches in `ActivityStats` are the
  propagated SQL error returns (need driver fault injection)
- `make test-dev` → all packages ok (staticcheck binary not present in this
  container; `go vet` runs via `go test`)
- `make gosec` → 0 issues across GOOS linux/darwin/windows
- `aidc-scan` → semgrep/gitleaks/gosec clean
- `make test-all` → all packages ok (incl. long-running concurrency tests)

### Verification

- `TestStore_ActivityStatsPerModel` (new): multi-model fixtures assert totals,
  first/last timestamps, per-model rows with cached-token exclusion (negative
  `cache_tokens` ignored), zero-speed exclusion from averages (`m2` reports
  `null` speeds), ordering by request count, the `?model=` filter narrowing
  totals/time-range/models, and an empty store returning zero totals with
  `null` timestamps and an empty non-nil `models` array.
- `TestServer_APIMetricsStats` (extended): asserts the endpoint serializes the
  per-model breakdown (speed averages 20/30 t/s for the fixture, RFC3339
  `last_used` round-trip) and that the unfiltered request aggregates all
  models with correct `first_timestamp`/`last_timestamp`.

### Notes

- The two new `#nosec G202` markers in `internal/store/store.go` (same
  placeholder-built-`where` pattern as the existing ones) are recorded in
  `docs/gosec-suppressions.md` (G202 count 3 → 5, total 89 → 91), verified by
  `TestNosecLedgerInSync`.
- `parseActivityLimit`'s 1–999 bound remains for the Activity table's
  pagination; only the Stats page's dependence on it was removed.

---


## 2026-09-02 — Intel GPU architecture/model from PCI device ID

### What

Linux hardware detection now fills the `architecture` field (and, for Battlemage
discrete cards, `model`) for Intel GPUs. On an Intel Arc B-series host the
Hardware tab previously showed `Architecture: Not detected` and a generic
`Gpu N` for both the discrete card and the integrated GPU.

### Why

`detectDRMSysfs` (`internal/hw/detect_linux.go`) only ever set architecture for
AMD (ROCm/KFD gfx strings) and NVIDIA — there was no Intel code path. Intel also
leaves the `.../device/product_name` sysfs attribute empty, so `model` fell back
to the generic label. Intel encodes the GPU generation in the PCI device ID
(`.../device/device`, e.g. `0xe20b`), so it is derivable without extra tooling.

### How

- New `internal/hw/intel.go` (platform-neutral, so it is unit-testable without
  Linux and reusable by the Windows dxgi path later): `intelGPU(deviceID uint16)`
  looks up a curated `map[uint16]string` (architecture) plus a small
  `map[uint16]string` (marketing model). IDs are grouped by platform with the
  source cited (kernel `include/drm/intel/pciids.h` `INTEL_*_IDS` macros + Mesa
  chipset tables). Coverage: DG1, Alchemist/DG2 + ATS-M, Battlemage/BMG G21, and
  integrated Tiger/Rocket/Alder/Meteor/Arrow/Lunar Lake. Unknown IDs return
  `ok=false`, leaving the field "Not detected" rather than guessing.
- Models are only assigned where a die maps unambiguously to one product name:
  Battlemage `0xE20B`→Arc B580, `0xE20C`→Arc B570, `0xE211`→Arc Pro B50,
  `0xE212`→Arc Pro B60. Alchemist dies and integrated parts (one die → many SKUs)
  get architecture only.
- `detectDRMSysfs` reads `.../device/device`, parses the hex ID as a `uint16`
  (`strconv.ParseUint(_, 16, 16)`, so the `uint16` conversion is bounded — no
  gosec G115), and when the vendor is Intel sets `Architecture` and falls back to
  the table model only when `product_name` is empty.
- No type/schema/UI change: `Architecture` and `Model` are already `*string` on
  `Accelerator` with no enum validation, and `hardware.js` already renders both.

### Commands

- `gofmt -w internal/hw/intel.go internal/hw/intel_test.go internal/hw/detect_linux.go`
- `go test -v -run TestIntelGPU ./internal/hw/` → 5 passed
- `make test-dev` → all packages ok, staticcheck clean
- `make gosec` → 0 issues across linux/darwin/windows
- `aidc-scan` → semgrep/gitleaks/gosec clean

### Verification

Unit tests (`internal/hw/intel_test.go`) cover discrete hits with model,
Battlemage/Alchemist architecture-only hits, one ID per integrated platform, and
unknown/boundary IDs (`0x4904`, `0x490A`, `0xE201`, `0xE224`, `0x56C3`, `0x0000`,
`0xFFFF`) that must miss. Real-hardware confirmation on the reporter's B-series
box is pending (should read `Architecture: Battlemage` for the `xe` card).

### Notes

- The table needs an occasional refresh as Intel ships new device IDs; the
  per-group source citations make that a copy-from-header task.
- Separate, still-open bug (not addressed here): the `xe` driver reports VRAM at
  `device/tile0/vram0/total_bytes`, not the amdgpu-only `mem_info_vram_total`, so
  discrete Intel VRAM still shows "Shared System".

## 2026-09-02 — Apple GPU Metal driver detection on recent macOS

### What

On an Apple M4 Max the Hardware tab showed `Driver: Not detected`. It now reads
`Metal 4` (name "Metal" + family version "4"). Architecture ("Apple M4"), Model
("Apple M4 Max") and unified memory were already correct; Power Limit stays "Not
detected" because Apple Silicon does not expose a per-GPU power cap.

### Why

`parseSystemProfiler` (`internal/hw/detect_darwin.go`) only set the driver when
`spdisplays_metal` / `spdisplays_metal_support` were present. Recent macOS
(Sequoia / macOS 26 on M4) reports Metal support under the renamed key
`spdisplays_mtlgpufamilysupport` with value `spdisplays_metal4`, which the old
lookup missed — confirmed from the machine's `system_profiler -json
SPDisplaysDataType` output.

### How

- New `internal/hw/apple.go` (platform-neutral, so it is unit-testable on Linux
  like `intel.go`): `metalFamilyKeys` lists all known key spellings newest-first
  (`spdisplays_mtlgpufamilysupport`, `spdisplays_metalfamily`,
  `spdisplays_metal_support`, `spdisplays_metal`) and `metalVersion(value)`
  extracts the family number via `(?i)metal\s*([0-9]+)` (`spdisplays_metal4`→"4",
  legacy `spdisplays_supported`→"").
- `detect_darwin.go` now resolves the value via `firstMapString(display,
  metalFamilyKeys...)` and sets `Driver{Name:"Metal", Version:metalVersion(...)}`;
  `nonEmptyStringPtr` keeps Version nil when the value has no number, so legacy
  values still render just "Metal".

### Commands

- `gofmt -w internal/hw/apple.go internal/hw/apple_test.go internal/hw/detect_darwin.go internal/hw/hardware_darwin_test.go`
- `go test -run 'TestMetalVersion|TestIntelGPU' ./internal/hw/` → pass
- `GOOS=darwin go vet ./internal/hw/` → clean (darwin tests can't execute on the
  Linux build host)
- `make gosec` → 0 issues across linux/darwin/windows; `aidc-scan` clean

### Verification

`TestMetalVersion` (neutral, runs on Linux) covers the metal4/metal3/legacy/empty
cases. `TestHardware_DarwinMetalDriverFamily` (darwin build tag) drives
`parseSystemProfiler` with the real M4 Max JSON and asserts `Metal`/`4`; it is
compile+vet-checked here and runs on macOS CI.

### Notes

- Architecture is intentionally the family ("Apple M4"), with the variant in
  Model ("Apple M4 Max"); left unchanged.
- Power Limit is not exposed for Apple Silicon GPUs — no fix possible from
  `system_profiler`.

## 2026-09-02 — Fix dead close buttons in the activity capture dialog

### What

On `/activity`, opening an entry's capture ("View") shows a modal whose close
controls (`×` in the header, `Close` in the footer) did nothing. The dialog
could only be dismissed via Escape or a backdrop click.

### Why

`captureDialog.js`'s `render()` produced two `[data-close]` buttons but wired
the click handler with `dlg.querySelector("[data-close]")`, which returns only
the first match. Depending on the branch, one button — or, in the
capture-not-found path, both — ended up without a handler.

### How

Changed the single `querySelector` bind to
`dlg.querySelectorAll("[data-close]").forEach(...)` so every close button in the
rendered dialog gets the `close` handler.

```diff
-    dlg.querySelector("[data-close]")?.addEventListener("click", close);
+    dlg.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));
```

### Commands

- `aidc-scan` → semgrep + gitleaks clean; all language scanners skipped (only
  a hand-authored JS file under `internal/server/ui_dist/` changed, no build
  step).

### Verification

Reviewed the rendered markup: both the header `×` and footer `Close` now match
the `[data-close]` selector and receive the handler.

### Notes

The web UI under `internal/server/ui_dist/` is vanilla ES-module JS served
directly with no build step, so no rebuild was required.

---

## 2026-09-02 — Fix `GOOS=windows gosec` build failure in vllm-wrapper

### What

`make gosec` failed its `GOOS=windows` pass — not on a finding, but on a compile
error: `cmd/vllm-wrapper/main.go:233:21: undefined: syscall.Kill`.

### Why

`syscall.Kill` is only defined on Unix-like platforms. The `sleep` subcommand
used it to send `SIGTERM` to the serve proxy PID after vLLM enters sleep mode.
Windows has no `syscall.Kill`, so the package would not compile under
`GOOS=windows`, and gosec aborts the whole target when a package fails to build.
(`syscall.SIGTERM` in the signal-handling path is fine — that constant is defined
on Windows; only `Kill` is missing.)

### How

Extracted the stop call behind a small `stopProcess(pid int) error` helper split
across build-tagged files:

- `cmd/vllm-wrapper/stop_unix.go` (`//go:build !windows`) → `syscall.Kill(pid, syscall.SIGTERM)`
  (unchanged graceful behavior on Linux/macOS).
- `cmd/vllm-wrapper/stop_windows.go` (`//go:build windows`) → `os.FindProcess(pid).Kill()`
  (Windows has no SIGTERM). This wrapper targets Linux/systemd deployments; the
  Windows build exists only to keep cross-compilation and gosec green.

`main.go` line 233 now calls `stopProcess(stopPID)`.

### Commands

- `GOOS=windows go build ./cmd/vllm-wrapper/` → ok
- `GOOS=linux go build ./cmd/vllm-wrapper/` → ok
- `go test ./cmd/vllm-wrapper/` → 5 passed
- `make gosec` → linux/darwin/windows all report `Issues: 0`, no build errors
- `aidc-scan` → clean

### Notes

Behavior on the primary Linux path is identical (still `SIGTERM`). The Windows
variant is a hard kill because the platform offers no graceful-termination
signal; acceptable given the wrapper is not deployed on Windows.

---

## 2026-09-02 — Fix TestDirWatcher_MissingDirRecovers Windows CI flake

### What

Windows CI (`make test-all`) failed:

```
--- FAIL: TestDirWatcher_MissingDirRecovers (0.05s)
    dirwatcher_test.go:147: Received unexpected error:
      unlinkat C:\...\TestDirWatcher_MissingDirRecovers.../001:
      The process cannot access the file because it is being used by another process.
```

### Why

The test removes the watched directory *while the `DirWatcher` goroutine is
running* (by design — it verifies the watcher survives a disappearing dir). The
watcher polls every 25 ms via `os.ReadDir`, which briefly holds an open handle
on the directory. Windows refuses to unlink a path another handle has open
(no `FILE_SHARE_DELETE`), so when the test's `os.RemoveAll(dir)` lands in the
same instant as a poll's `ReadDir`, it returns a sharing violation. POSIX
`unlinkat` has no such restriction, so linux/darwin never hit it.

### How

Added a `removeDirWithRetry` test helper that retries `os.RemoveAll` up to 50×
with a 10 ms backoff (≤500 ms, 20× the poll interval) and used it at the mid-run
removal site. The watcher's handle is only held for the microseconds of a
`ReadDir` call, so a retry quickly finds a gap. First attempt succeeds on
non-Windows, so behavior there is unchanged. Test-only; the watcher itself
already handles a missing directory correctly (`scanDir` returns
`exists=false`).

Other removals in the watcher tests operate on single files, not the directory,
so they don't hold the directory handle that `ReadDir` does and were left as-is.

### Commands

- `gofmt -w internal/watcher/dirwatcher_test.go`
- `GOOS=windows go vet ./internal/watcher/` → ok
- `go test -run TestDirWatcher -count=3 ./internal/watcher/` → 24 pass
- `go test ./internal/watcher/` → pass

### Notes

Could not reproduce on the linux dev host (POSIX semantics); the fix targets the
exact Windows error and is a no-op cost on other platforms.

---

## 2026-09-02 — Fix TTL_IgnoresWebsocket deadlock (fork feature collision)

### What

`TestProcessCommand_TTL_IgnoresWebsocket` (`internal/process`) intermittently
deadlocked in CI, tripping the 10-minute test timeout and failing `make
test-all` / `make test-dev`. The trace showed a `panic: close of closed channel`
at `process_command_test.go:907` and a `httptest.Server blocked in Close` on an
active connection.

### Why

A collision between two independently-pulled features:

- The test (upstream PR #1002) uses a mock upstream that treats *any non-`/health`
  request* as "the websocket": it `close(websocketStarted)`s and then blocks on
  `<-releaseWebsocket`.
- The fork's dynamic-reasoning capability (upstream PR #915) added a `/props`
  reasoning-budget probe in `doStart` (`upstreamSupportsThinkingBudget`, fired
  when the command has no fixed budget — which the test's `simple-responder`
  does not).

At startup the `/props` probe hit the mock's non-`/health` branch, closing
`websocketStarted` early and leaving a mock handler goroutine parked on
`<-releaseWebsocket`. Then the test's real websocket request called
`close(websocketStarted)` again → `close of closed channel` panic (recovered by
`net/http`, but it severed the proxied response → `unexpected EOF` → the request
returned early). The test then failed at line 942
(`websocket request completed before it was released`) via `t.Fatal`, which
skipped `close(releaseWebsocket)`; the `t.Cleanup` `mock.Close()` then blocked
forever on the still-parked `/props` goroutine → 10-minute timeout.

### How

Changed the mock upstream to block only on the *actual* websocket upgrade,
answering every startup probe (`/health`, `/props`, anything else) with `200`
immediately — mirroring production's `swaputil.IsWebSocketUpgrade` check:

```go
if !swaputil.IsWebSocketUpgrade(r) {
    w.WriteHeader(http.StatusOK)
    return
}
close(websocketStarted)
<-releaseWebsocket
w.WriteHeader(http.StatusOK)
```

The `/props` probe now gets an empty-body `200` (`build_info` absent →
`reasoningDynamic=false`), so it no longer parks a goroutine, and only the real
`/socket` upgrade drives the block-until-released sequence the test asserts on.
Test-only change; no production behavior touched.

### Commands

- `make simple-responder` (test needs the helper binary)
- `go test -v -run TestProcessCommand_TTL_IgnoresWebsocket -count=5 ./internal/process/` → 5/5 pass
- `go test ./internal/process/` → 46 pass (was a 600s timeout)
- `make test-all` → all packages `ok`
- `gofmt -w internal/process/process_command_test.go`; `aidc-scan` → clean

### Notes

Root cause is the fork carrying both upstream PR #1002 (the test) and PR #915
(the `/props` probe) that upstream did not have to reconcile against each other.
The fix hardens the test's mock so any future startup probe is tolerated too.

---

## 2026-09-02 — Suppress DXGI COM interop gosec false positives (Windows)

### What

CI `gosec` (pinned to `v2.26.1` in `.github/workflows/gosec.yml`) reported 12
`GOOS=windows` findings in `internal/hw/dxgi_windows.go` — 5×G115 (integer
overflow) and 7×G103 (`unsafe.Pointer`). The local `make gosec` uses an older
`gosec` (`dev`) that predates the G115 rule, so these were invisible locally.

### Why

Both classes are false positives inherent to DXGI COM interop:

- **G115 (HRESULT/LUID):** an `HRESULT` is a 32-bit status code returned from a
  syscall as `uintptr`. Truncating it to `uint32`/`int32` and testing the sign
  bit is the documented Win32 `SUCCEEDED`/`FAILED` semantics, not an overflow.
  The `luid:%08x` identity likewise reinterprets the fixed 32-bit `AdapterLUID`
  ABI field for display.
- **G103 (`unsafe.Pointer`):** mandatory to pass the COM factory/adapter vtable
  pointers and `DXGI_ADAPTER_DESC` struct across the `syscall.SyscallN` /
  `LazyProc.Call` boundary. Same by-design verdict as the existing
  `pdh_windows.go` / `d3dkmt_windows.go` sites.

### How

Added inline `// #nosec G115 -- …` / `// #nosec G103 -- …` markers at the exact
flagged lines (4 G115 markers — one covers the two conversions on the
`hresultFailed` line — and 7 G103 markers), matching the established style. No
code was restructured to dodge the scanner. Updated the audit ledger
`docs/gosec-suppressions.md`: summary totals (G115 25→29, G103 20→27, total
78→89) and the G115/G103 section prose to name `dxgi_windows.go`. The
`TestNosecLedgerInSync` guard enforces the marker/ledger counts stay in sync.

### Commands

- `go install github.com/securego/gosec/v2/cmd/gosec@v2.26.1` (match CI)
- `GOOS=windows gosec ./internal/hw/` → `Issues: 0`
- `GOOS={linux,darwin,windows} gosec ./...` → all `Issues: 0`, no build errors
- `GOOS=windows go build ./internal/hw/` → ok
- `gofmt -w internal/hw/dxgi_windows.go`
- `go test ./internal/audit/` → `TestNosecLedgerInSync` passes
- `aidc-scan` → clean

### Notes

`make gosec` locally still runs the `dev` gosec, which under-reports vs CI. The
verification above installed the CI-pinned `v2.26.1` explicitly to reproduce and
confirm the fix. Consider pinning the same version in the Makefile as a
follow-up so local and CI agree.

---

## 2026-09-02 — Maximal upstream integration (re-established on upstream `7a14664`)

### What

Rebuilt the fork on top of upstream `7a14664` (2026-08-31) instead of merging 96
divergent upstream commits into a heavily-rewritten tree. Upstream's new
scheduler, selectors, profiles, peer namespaces, `internal/matrix`,
`internal/hw`, ComfyUI, sqlite `internal/store`, and docagent/mcptools are
inherited natively; the fork's differentiators (Anthropic `apiconv`, Ollama
compat, vanilla `ui_dist` UI, passthrough config, gosec hardening, guardrails)
were re-applied on top as a curated patch series.

### Why

A straight merge was infeasible: nearly every upstream commit collided with the
files the fork rewrote (`server.go` routes, config, router), and upstream's
naming refactor (#1003) touched symbols referenced throughout the fork.

### How / verification

Phase-by-phase, each verified with `go build ./...` + targeted `go test` before
advancing; full `go test ./internal/...` green (20 packages). Adopted upstream's
sqlite store (dropped the file-based metrics store). See the session log
`logs/2026-09-02-upstream-max-integration.md` for the per-phase diff, commands,
and the gosec baseline/oracle.

### Notes

- Selectors/profiles/capabilities are **API-only** on this branch (the vanilla
  UI has no screens for them yet) — deferred follow-up.
- The `/stats` page aggregates over the most recent ≤999 activity rows
  (server-side limit) rather than all-time — deferred rewire onto
  `/api/metrics/stats`.

---

## 2026-07-04 — Router swap deadlock on TTL unload race (+ failed-start variant, TTL first-tick unload)

### What

Fixed a permanent whole-router deadlock in the swap path and two adjacent
defects in the process state machine:

1. A request arriving while its target model was mid-TTL-unload
   (`StateStopping`) wedged the router forever.
2. A failed model start (crash on load, health-check timeout) had roughly
   even odds of wedging the router the same way, depending on channel
   receive ordering.
3. A model reloaded after an idle gap longer than its `ttl` inherited a
   stale idle timestamp and could be unloaded again by the TTL goroutine's
   first 1-second tick, before the request that triggered the reload was
   served.

Changed files: `internal/process/process.go`,
`internal/process/process_command.go`, `internal/router/base.go`, tests in
`internal/process/process_command_test.go`, `internal/router/helpers_test.go`.

### Why (incident)

2026-07-04, production host "bigdumbo": `gemma4-31b-mtp` (ttl 600) hit its
TTL at 05:53:30 IST; an opencode request for the same model arrived ~100 ms
later. From that moment every `/v1/chat/completions` request — for any model
— hung until client timeout and was logged as `200` with a 0-byte body
(`metrics: empty body, recording minimal metrics`), `/running` returned
`[]`, and the GPU sat idle with no upstream processes. The client's 60-min
timeout + instant retry produced an hourly recurrence until the service was
restarted. Ops-side RCA log:
`machine-config/logs/bigdumbo/2026-07-04-llama-swap-ttl-swap-wedge-rca-fix.md`.

### Root cause

`baseRouter.doSwap` composed three non-atomic process operations:

```go
if target.State() == process.StateStopped {   // snapshot
    go func() { target.Run(timeout) }()       // maybe start
}
err := target.WaitReady(b.shutdownCtx)        // wait
```

During a TTL unload the snapshot observes `StateStopping`, so `Run()` is
skipped; the `WaitReady` send then pends while `run()` is inside its
`stopCh` case and is only received after the transition to `StateStopped`,
where it was appended to a parked-waiter list (`readyWaiters`). Parked
waiters were only woken by a future `Run()` resolution — and the only
`Run()` caller was the very `doSwap` that had already declined to call it.
The swap goroutine therefore never reported `swapDone`; its entry in the
router's `active` map never cleared; same-model requests joined the dead
swap and requests for other models queued behind it via eviction collision.

The failed-start variant is the same parking defect with a different
trigger: `go Run()` and `WaitReady()` race to `run()`'s select; when `runCh`
is received first and the start fails, the failure notification fires while
the `WaitReady` send is still blocked on the channel — it parks afterwards,
unwakeable.

Key insight: **no notify-on-transition scheme can fix this** — a sender
still blocked on the channel when the transition fires always parks after
the notification. The parked-waiter state itself had to go.

### How

- `internal/process/process_command.go`:
  - `runReq` gained a buffered `ready chan error`. `run()` answers it at
    every start resolution: success (`nil`), start failure, stop-during-
    start (`ErrStartAborted`), parent-context shutdown. A `runReq` received
    while already `StateReady` answers `ready` with `nil` (ensure semantics:
    already-ready is success, not a conflict).
  - New `EnsureReady(ctx, timeout)` sends that request and waits on `ready`.
    Because the start decision happens inside `run()` against live state, a
    request that pends during an in-flight Stop is received afterwards at
    `StateStopped` and simply starts the process.
  - `WaitReady` answers immediately from current state — `nil` when ready,
    shutdown error, or wraps the new `ErrNotStarted` sentinel. The
    `readyWaiters`/`notifyWaiters` machinery is deleted. (In the main select
    the state is only ever `Stopped` or `Ready`; sends made while a start or
    stop is resolving pend on the channel and get the post-resolution
    answer.)
  - `lastUse` is set to now on successful start — becoming ready counts as
    use for the TTL idle clock.
  - `case <-cmdDone:` (unexpected upstream exit) logs at Warn when no `Run`
    caller is parked; with the router on `EnsureReady`, nothing else would
    surface it.
  - `Run` keeps its contract (blocks until termination) for API
    compatibility; `EnsureReady` callers do not park a termination response.
- `internal/router/base.go`: `doSwap` stops evictions as before, then calls
  `b.processes[modelID].EnsureReady(b.shutdownCtx, timeout)` and reports the
  result on `swapDoneCh`. Failed swaps now propagate a real error to every
  waiter (`SendError`) instead of hanging them.
- `internal/process/process.go`: interface gains `EnsureReady`; `WaitReady`
  contract documented as fail-fast.
- Tests: router `fakeProcess` implements `EnsureReady` (preserving the
  `runCalls`/`runStarted`/`readyCh` hooks existing tests observe);
  `runAsync` helper retries `ErrNotStarted` while its `Run` goroutine
  registers.

### Verification

Toolchain: go 1.26.4 darwin/arm64; `make simple-responder` prebuilt.

```
go test -race -count=1 ./internal/process/    20 passed
go test -race -count=1 ./internal/router/    102 passed
GOOS=linux GOARCH=amd64 go build ./...       OK
make gosec                                   0 issues (73 files, 3 GOOS)
gofmt / go vet                               clean
```

New regression tests (`internal/process/process_command_test.go`):

- `TestProcessCommand_EnsureReadyDuringStop` — reproduces the incident: an
  upstream started with `-ignore-sig-term` holds `run()` in its stop case
  for a ~1.5 s graceful window; `EnsureReady` issued mid-stop rode it out
  and had the model restarted and serving in 1.74 s. Pre-fix behaviour:
  parked forever.
- `TestProcessCommand_EnsureReadyStartFailure` — failing command reports an
  error promptly (pre-fix: ~50 % permanent park).
- `TestProcessCommand_EnsureReady` — start + ready + idempotent re-call.
- `TestProcessCommand_WaitReadyNotStarted` — fail-fast `ErrNotStarted`.
- `TestProcessCommand_StartResetsLastUse` — TTL idle clock reset on start.

Known flake (pre-existing, unrelated): under whole-repo parallel load the
bash-wrapper tests `TestProcessCommand_StopForkingWrapper` /
`TestProcessCommand_StopHonorsGracefulTimeout` can miss their 3 s startup
budgets; verified identical on the unpatched tree and 3/3 passes in
isolation.

### Notes

- The two semgrep findings on the touched files are the long-standing,
  documented G204 subprocess sites (`docs/gosec-suppressions.md`) — running
  operator-configured model commands is llama-swap's purpose; untouched by
  this change.
- Candidate for upstreaming: upstream `mostlygeek/llama-swap` (post-#790
  backend, divergence baseline `ccfba0d`) contains the same
  snapshot+`Run`+`WaitReady` composition in `doSwap` and the same parking
  `WaitReady`, so the deadlock class applies there too.
