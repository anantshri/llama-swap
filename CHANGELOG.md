# Changelog

All notable changes to this fork are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries track this fork's deltas on top of the upstream base (see the fork
notice in [README.md](README.md); divergence baseline: upstream `7a14664`).
Long-form entries with full context live in
[DETAILED_CHANGELOG.md](DETAILED_CHANGELOG.md).

## [Unreleased]

### Added

- Port of upstream PR #1075: a `setParams`/`setParamsByID` key ending in `?`
  (e.g. `max_tokens?: 4096`) is set-if-undefined — the value applies only when
  the request does not already carry that parameter, so configs can supply
  defaults without clobbering clients. Works on model and peer filters;
  stripped parameters count as undefined and a hard spelling of the same key
  wins over the `?` form. Backward compatible (fixes upstream #1052).
- Approximate token-cost estimates on the Stats page. A new top-level
  `pricing:` config section sets the display currency (USD, or INR with a
  configurable `usdToINR` rate, default 95) and default per-million-token
  rates; a per-model `pricing:` block overrides them. The server publishes the
  snapshot through `GET /api/metrics/pricing` and embeds it in
  `/api/metrics/stats`; the Stats page shows an "Est. Cost" summary tile and a
  sortable per-model column. Cached tokens are deducted from billable input
  and charged at their own rate (the input rate when unset). The UI's Settings
  page adds per-browser overrides (cost on/off, currency, INR rate, default
  rates) plus a "Compact large numbers" toggle that compresses Stats-page
  token/request counts to M/B/T suffixes with exact values on hover.
  Documented in `README.md` (fork notice, API list, Web UI, Configuration)
  and `docs/config.example.yaml`.

### Added (selective upstream-PR ports)

- Surface the upstream's own log output in the error when a model process exits
  before becoming ready, instead of the opaque "upstream command exited
  prematurely" (upstream PR #897).
- `POST /models/unload` — llama.cpp-compatible named-model unload used by
  Open WebUI (upstream PR #924).
- `setParamsByMatch` request filter: set parameters when a request field
  matches a configured value, plus map/list macros usable as whole values
  (upstream PR #934).
- Per-model output-token caps (`capabilities.max_output_tokens`) enforced after
  user filters, and dynamic reasoning-effort selection for llama.cpp b8605+
  (`capabilities.reasoning` with per-effort budgets); both surfaced as
  `/v1/models` metadata extensions (upstream PR #915). The capability probe is
  bounded by a 2s timeout so an unresponsive upstream cannot stall startup.
- Matrix `+undefined` reference: a set can include every model not named by
  any other set expression (upstream PR #1026).

### Changed

- Simplified the web UI's vanilla JS/CSS base with zero functional change:
  30 files, net −227 lines. Shared helpers now carry what each interface
  re-implemented locally — a playground task lifecycle (`runTask`), stage
  spinner/error templates, `escapeHtml`/download/copy/scroll helpers, REST
  wrappers on `fetchOk`/`apiFetch`/`postJSON`, a throttled conversation
  saver, a shared SSE reader loop for the three chat streaming parsers, and
  `statusDotClass`/`modelServerPath` in `util/modelUtils.js`. Dead code and
  unused CSS rules removed; verified behavior-identical via golden-output
  harnesses (stream parsers, markdown, DOM-free modules) and the full Go
  test suite. Also fixes a latent crash: the image playground's SDAPI
  settings panel referenced an unimported `escapeHtml` (ReferenceError on
  open).
- Fixed the Settings page and header tooltip showing "unknown" for Version,
  Commit Hash, and Build Date: the UI's `versionInfo` store was never populated.
  It now fetches `GET /api/version` once at boot.
- The Stats page aggregates server-side from `/api/metrics/stats` instead of
  fetching `/api/metrics/activity?limit=999`, so per-model totals now cover the
  entire activity log rather than the most recent 999 requests. The stats
  endpoint gained `first_timestamp`, `last_timestamp`, and a per-model `models`
  breakdown (requests, tokens, cached tokens, average speeds, total duration,
  last used) computed in SQL.
- Re-established the fork on upstream `7a14664` (2026-08-31), inheriting the new
  scheduler, selectors, profiles, peer namespaces, `internal/matrix`,
  `internal/hw`, ComfyUI compatibility, `internal/store` (sqlite activity
  metrics), and the docagent/mcptools reference subsystem. The fork's
  differentiators were re-applied on top rather than merged commit-by-commit.
- Adopted upstream's sqlite `internal/store` for activity metrics, replacing the
  fork's file-based JSON metrics store.

### Added

- Sortable Stats page table: every column header sorts client-side (click
  toggles asc/desc, requests-descending default), mirroring the Activity
  table's `data-sort` + indicator pattern (folded from fork PR #19, fixes #18).
- Pin captures from the Activity page: each row's capture column gains a 📌
  button that persists the request/response into the sqlite store
  (`pinned_captures` table), where it survives memory-cache eviction until
  deleted via the pinned badge (with confirmation). `GET /api/captures/{id}`
  falls back to pinned captures, and activity rows expose `pinned` alongside
  `has_capture`.
- Anthropic Messages API translation (`internal/apiconv`): `/v1/messages` and
  `/v/messages` are translated to OpenAI chat-completions and back (buffered +
  streaming), with a `passthroughAnthropic` per-model opt-out.
- Ollama `/api/*` compatibility layer (`internal/ollama`) with a
  `passthroughOllama` opt-out and a `HEAD /` reachability probe.

### Removed

- The Svelte UI and its npm build step: the hand-authored vanilla-JS SPA under
  `internal/server/ui_dist/` is embedded via `//go:embed` (no build tag).

### Added (upstream UI feature port to the vanilla JS UI)

- Activity page rebuilt on the server-backed store: paginated
  `/api/metrics/activity` with server-side sorting, min/max-ID filters,
  live-refresh throttled on the SSE `activity` revision, store-computed
  `/api/metrics/stats` cards + histograms, in-flight requests table with
  cancel, and markdown export of the visible rows.
- SSE layer updated to the upstream event set (`activity`, entry-based
  `inflight`, `uiConfig`, `profileChanged`) — the old fork-specific
  full-metrics-payload events no longer exist server-side.
- Models page: profiles card (active profile, pin mappings, switcher),
  selectors card (targets/strategy/spillover), capability badges + context
  window per model, model-server open link.
- Model detail page (`/models/:id`): Activity / Logs (per-model stream) /
  Details (capabilities) tabs; param-aware hash router.
- Hardware page from `/api/hardware` with a copyable plain-text summary;
  Settings page (theme mode, capability-tag toggle, build info).
- Logs: ANSI color rendering (SGR → styled spans, theme-aware palettes).
- Playground: Load Test tab (concurrent streaming requests with Gantt-style
  phase timeline, drag-to-reorder result cards) and Help tab — the docs agent
  over the server's MCP tools (`/api/mcp`) with a full agent loop
  (tool-call accumulation, sanitize-on-reload, max-iterations continue).
- perf: sysfs GPU provider (Intel xe/i915 + generic hwmon/fdinfo) with hwmon
  reads throttled to 5s while the GPU is active, so hosts without
  nvidia-smi/rocm-smi/LACT (e.g. Intel Arc) get GPU telemetry and idle cards
  stay runtime-suspended. Cherry-picked from the fork's `intel-card` branch.

### Fixed

- Intel discrete GPUs (Arc / Flex) on the Hardware page no longer report
  "Shared System" memory with no capacity: a new `xpu-smi` (Intel XPU Manager)
  probe supplies the dedicated VRAM size and merges over the sysfs record by
  PCI address, matching the existing `nvidia-smi`/`rocm-smi` probes. Applies
  when the driver does not expose `mem_info_vram_total` in sysfs. Follow-up
  fix for a regression in the first cut: the sysfs probe looked for render
  nodes under `/sys/dev/dri` (which does not exist), silently dropping every
  sysfs accelerator record — Architecture and Power Limit showed "Not
  detected" on hosts where they had worked before. Render-node lookup is back
  to `/dev/dri`, guarded by a fixture test with disjoint sysfs/dev roots. The
  xpu-smi probe now also derives Architecture from the reported PCI device
  ID, the Arc Pro B65/B70 model names were added, and the swapped B50/B60
  entries were corrected (per the pci.ids database).
- Activity page rows render again. The pin-button change referenced
  `pinningId` from `cellHtml`, a module-scope function where that variable does
  not exist, so any row with a capture threw a `ReferenceError` and the
  refresh's `catch` left the table empty. `pinningId` is now passed to
  `cellHtml` like `loadingCaptureId`.
- Intel GPU hardware detection now reports an architecture (and, for Battlemage
  discrete cards, a model) on Linux by mapping the PCI device ID to a generation
  codename — DG1, Alchemist, Battlemage, and recent integrated Xe (Tiger/Rocket/
  Alder/Meteor/Arrow/Lunar Lake). Previously both fields showed "Not detected"
  because the sysfs detector never populated architecture and Intel leaves
  `product_name` empty.
- Apple GPU driver now shows "Metal" (with family version, e.g. "Metal 4")
  instead of "Not detected" on recent macOS. `system_profiler` renamed the
  Metal-support key to `spdisplays_mtlgpufamilysupport`; the detector now probes
  that alongside the older `spdisplays_metal*` spellings.
- Activity capture dialog: the header `×` and footer `Close` buttons both work
  again. The render bound a click handler to only the first `[data-close]`
  element via `querySelector`, leaving the other button dead.
- `cmd/vllm-wrapper` now cross-compiles for Windows: the `syscall.Kill` call
  (Unix-only) moved behind a build-tagged `stopProcess` helper
  (`stop_unix.go` / `stop_windows.go`), unblocking `GOOS=windows gosec`.
- Documented the DXGI COM interop `gosec` false positives in
  `internal/hw/dxgi_windows.go` (G115 HRESULT/LUID truncation, G103
  `unsafe.Pointer` vtable calls) with inline `#nosec` markers, so the newer
  CI `gosec` (v2.26.1) reports zero findings on the Windows target.
- `TestProcessCommand_TTL_IgnoresWebsocket` no longer deadlocks (10-minute CI
  timeout): its mock upstream now blocks only on the real websocket upgrade,
  so the fork's `/props` reasoning-budget startup probe is answered instead of
  tripping the block-until-released path.
- `TestDirWatcher_MissingDirRecovers` no longer fails on Windows CI: the
  mid-run directory removal retries briefly to tolerate the transient Windows
  sharing violation when the watcher is polling the directory concurrently.
- `TestConfig_LoadWindows` no longer fails on Windows CI: its expected `Config`
  was missing the normalized `pricing:` defaults (`currency: USD`,
  `usdToINR: 95`) that `Load` now applies, unlike the already-updated posix
  twin of the test.

### Security

- Handled every `gosec` G104 unhandled-error finding explicitly and added
  `ReadHeaderTimeout` to every `http.Server` (G112). `make gosec` reports zero
  findings across `GOOS=linux/darwin/windows`; remaining findings are documented
  false positives in [docs/gosec-suppressions.md](docs/gosec-suppressions.md).
- Fixed a GitHub Actions shell-injection in `release.yml` (untrusted
  `workflow_dispatch` input now passed via `env`).
