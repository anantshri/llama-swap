# Changelog

All notable changes to this fork are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries track this fork's deltas on top of the upstream base (see the fork
notice in [README.md](README.md); divergence baseline: upstream `7a14664`).
Long-form entries with full context live in
[DETAILED_CHANGELOG.md](DETAILED_CHANGELOG.md).

## [Unreleased]

### Added

- Docs: new KB guide `guides/api-integration/opik` — running Opik (open-source
  LLM observability/evaluation) against llama-swap's OpenAI-compatible `/v1`
  endpoint: the AI Providers "vLLM / Custom provider" setup for the Playground
  and Online Evaluation (including the Docker host networking gotcha), and the
  Python SDK LLM-as-judge configuration via `OPENAI_BASE_URL` + the LiteLLM
  `openai/` model prefix.
- Models dashboard: model descriptions now start collapsed to their first
  line with an expandable chevron (expanded state survives the frequent SSE
  re-renders), and a filter box matches model id, name, alias, and
  description text — including peer models; a matching peer group name shows
  the whole group. While filtering, the Profiles/Selectors cards yield the
  screen to the matches and a no-match empty state names the query. The
  models table uses a fixed layout so the Load/Unload and State columns stay
  on screen beside long descriptions, and long URLs wrap instead of forcing
  a horizontal scrollbar.
- Playground model pickers on capability-bound tabs (Images, Audio, Speech,
  Rerank) now list only models that fit the tab by default — a
  text-generation model no longer clutters the Images tab. A footer toggle
  shows the full list (with the hidden count) and flips back; tabs without a
  capability constraint (Chat, Docs) are unchanged.
- Stats page: usage is now split into two tables — **Active Models** (still
  present in the running configuration, matched via `/v1/models` plus the
  live SSE store including aliases) and **Inactive Models** (usage history
  for models removed or renamed since). Both share sort state; a model
  removed mid-session moves to Inactive without a reload.
- Logs page: each log panel gained a persistent "concerns" filter (warning
  triangle button) that keeps only lines worth escalating — `[WARN]`/
  `[ERROR]`/`[FATAL]`/`[PANIC]` level tokens, severity words in upstream
  output (warn/error/fatal/panic/crash/critical/failed/exception/traceback/
  SIGSEGV/SIGABRT/SIGTERM), and 4xx/5xx access-log statuses. Composes with
  the existing regex filter.
- Activity captures: the capture dialog's Request Body gained a **Parts** view
  that splits a JSON request into separately readable pieces — top-level
  `system`/`instructions`, every `messages[]` entry by role (including bare
  Responses-API `function_call` / `function_call_output` input items), each
  tool call and tool result, and the tool definitions — with per-part
  character, word and approximate token counts (≈1 token per CJK character,
  other text chars ÷ 4; the proxy ships no tokenizer, so the number is
  labelled an estimate). Multi-part requests open on the parts view;
  single-part bodies keep the pretty JSON view. `Collapse all` / `Expand all`
  controls sit next to Copy for long contexts, and tool results, tool-call
  inputs and function outputs that carry JSON are rendered pretty-printed.
- Port of upstream PR #1075: a `setParams`/`setParamsByID` key ending in `?`
  (e.g. `max_tokens?: 4096`) is set-if-undefined — the value applies only when
  the request does not already carry that parameter, so configs can supply
  defaults without clobbering clients. Works on model and peer filters;
  stripped parameters count as undefined and a hard spelling of the same key
  wins over the `?` form. Backward compatible (fixes upstream #1052).
- Global concurrency limit: a top-level `globalConcurrencyLimit` caps
  inference requests served at once across all models combined, independent
  of per-model limits. Default 0 (no limit); once the cap is reached requests
  are rejected with HTTP 429 rather than queued. Implemented as middleware at
  the top of the inference chain, only wired when the limit is > 0
  (upstream #1086/#1110, commit `41ec321`).
- Docs Agent `get_config` tool now answers jq queries instead of a dotted
  path: the agent can request exactly the slice of the running configuration
  it needs (`.models | keys`, `.models.qwen3`, …) instead of paging through a
  full dump. Evaluation is bounded by a 5s timeout, a value-count cap, a
  32 KB result cap, and a heap-growth guard, since `/api/mcp` needs no
  credentials by default and jq is a real language. The Help agent's system
  prompt documents the query form (upstream #1087/#1085, commit `a77f107`).
- Automatic capability discovery (new `internal/capcompat`): when a model
  becomes ready, llama-swap asks the upstream what it supports — context
  length, input/output modalities, tools — and caches the result in the
  sqlite store (new `cache` table), so an unloaded model still advertises its
  real capabilities in `/v1/models`. Configured `capabilities` always win
  field-by-field; `capabilities.disableAuto: true` opts a model out.
  Probes support llama-server, vLLM, and halogen (Strix Halo) upstreams. The
  activity store gains a general-purpose key/value cache API (upstream
  #1083/#1105, commit `eeac3e6`).
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

### Fixed

- perf sysfs GPU provider (Linux): GPU/VRAM temperature, fan and power
  charts no longer saw-tooth to zero while a model is busy. On cards that
  runtime-suspend between generation bursts (observed on Intel Arc B70 /
  xe) an hwmon pass can fail entirely while the device wakes up, and the
  poller published the zeroed sample as-is — the live feed alternated
  `temp 70 / 0 / 70 / 0` mid-generation. Failed passes are now retried once
  after 100ms (the first read kick-starts the resume), last-known values
  are carried forward for up to 30s (power only while the card is busy),
  and the throttle clock advances only on successful passes so failures
  are retried next tick.
- perf sysfs GPU provider (Linux): fdinfo records without `drm-pdev`
  (kernels before ~6.8) were counted on every discovered GPU — on multi-GPU
  hosts this inflated VRAM/utilisation and marked idle cards active (which
  then woke them for hwmon reads). Records are now attributed through the
  render node's sysfs device link, and unattributable records are skipped
  when more than one GPU is present. Duplicated or fork-inherited DRM fds
  sharing one `drm-client-id` no longer double-count VRAM. Test suite moved
  to the repo's `TestSysfs_<case>` naming convention.
- hw Intel detection: an xpu-smi detail response with an empty BDF no longer
  discards the device before the listing's BDF fallback can apply;
  integrated GPUs no longer publish borrowed system RAM as memory capacity;
  a generic `Intel(R) Graphics [0x…]` device name is replaced by the mapped
  marketing name from the PCI table (e.g. Arc Pro B60); Battlemage table
  gains device ID `0xE215`; the absent-tool test no longer depends on the
  host's installed binaries.

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
- Proxy forwarded headers: activity records now carry the client source —
  `xff:`-prefixed when taken from `X-Forwarded-For`/`X-Real-IP`, otherwise
  `ip:` + connection address — persisted as `ActivityLogEntry.Src` via a new
  sqlite migration and accepted as an activity sort key (upstream #1130,
  commit `2edad4a`).
- Request totals survive activity pruning: stats `TotalRequests` uses
  `MAX(id)` instead of `COUNT(*)` so the all-time total stays stable
  (upstream #1136, commit `96e6f94`).
- A model's TTL idle window now starts when the process becomes ready, so a
  positive-TTL model gets its full idle window even before the first request
  (upstream #1095, commit `21bc145`).
- The zstd encoder pool is replaced by a single bounded shared encoder,
  cutting retained memory from ~20 MiB per core to one bounded instance
  (upstream #1123, commit `0e1f797`).
- tabbyAPI `usage` extensions (`prompt_tokens_per_sec`,
  `completion_tokens_per_sec`, `total_time`) are extracted into activity
  metrics (upstream #1104, commit `8fa8589`).
- Configurable CORS controls (upstream #1133, commits `769dbac` + follow-up):
  a new `security.cors` config block — `allowedOrigins`, `allowCredentials`,
  `allowPrivateNetwork`, `allowedMethods`, `allowedHeaders`,
  `exposedHeaders`, `maxAge`. Omitting `allowedOrigins` keeps the permissive
  any-origin default; setting it switches to deny-by-default. CORS headers
  are only sent when the request carries an `Origin`, and upstream-set CORS
  headers are stripped from proxied responses so exactly one set reaches the
  client. Replaces the old hardcoded permissive middleware; the redundant
  `/api/tags` Origin echo was removed (it would have bypassed the
  restriction).
- Clean upstream cherry-pick batch (no hand merges required):
  - ComfyUI models' `concurrencyLimit` floor raised from 50 to 999 — one
    open ComfyUI tab makes many parallel asset and API requests, so the old
    floor was still throttling it (upstream #1189, commit `7e18554`).
  - `/v1/systemone` is routed through the POST-JSON model dispatch
    (upstream #1197, commit `45b78e2`).
  - Capability discovery gained a `defaultProber` fallback that works off
    plain `/v1/models` JSON, replacing the vllm-specific prober in the
    chain so unknown upstreams still get context length and text in/out
    capabilities detected (upstream #1198, commit `9db37d0`).
  - oMLX usage fields (`prompt_tokens_per_second`,
    `generation_tokens_per_second`) are extracted into activity metrics
    (upstream #1199, commit `783c323`).
  - Per-model `disableKeepAlives` option: llama-server advertises
    `Keep-Alive` on streamed responses and then closes the connection, so a
    POST right after a stream could hit `proxy error: EOF` (502) on the
    pooled connection; the option disables upstream connection pooling for
    models that need it (upstream #1205, commit `d60d084`).
  - wol-proxy: `-require-confirm` flag with a confirmation page and wake
    progress tracking, so monitoring probes don't restart the target server
    (upstream #1213, commit `8db9566`).
  - docker/unified audio.cpp: download and mp3 support (upstream #1157,
    commit `aa8031f`); static eSpeak-ng build with phoneme data installed
    (upstream #1182, commit `a6f3b09`).
- Upstream picks whose only conflicts were the deleted Svelte UI — resolved
  by dropping `ui/src` and porting the user-visible half to the vanilla UI:
  - DGX Spark (GB10) hardware detection (upstream #1163, commit `ccccb20`),
    with the Svelte Hardware-page changes ported to the vanilla page: a
    Device row (`system.vendor/model/family` — e.g. "NVIDIA DGX Spark
    (GB10)") in the System card and text summary, and Power now falls back
    to `nominal_power_watts` ("W (nominal SoC)") when no power limit is
    reported.
  - Model uptime tracking: `modelStatus` entries carry `readySince` (RFC
    3339) and `uptimeMs`; the models table's State cell shows a
    live-ticking uptime (updated in place once a second, computed from the
    server-provided `uptimeMs` so browser clock skew cannot skew it, and
    anchored per uptime value so unrelated re-renders never reset the
    displayed age) and the model detail Details tab shows uptime +
    ready-since. The playground marks interrupted turns — aborted turns
    keep a "Cancelled" turn with its Retry, failed turns mark their error
    and retry (upstream #1173, commit `85a109b`; sidebar resize and
    middle-truncated IDs are Svelte-shell specifics with no vanilla
    equivalent, and the docs-agent variant was left as-is).
  - `/audiocpp/` passthrough endpoint serving audio.cpp's own web UI via the
    reserved `audiocpp_auto` model, with the open-model link on the models
    table targeting it (upstream #1223, commit `fd49827`; G710 suppression
    carried over from comfyui.go — same fixed-prefix same-origin redirect).
- perf: a GPU collector that stops (e.g. nvidia-smi crashing or being
  absent while the monitor runs) is restarted with a doubling backoff
  (5s→30s, reset after a collector delivers stats), and nvidia-smi exits are
  logged instead of silently discarded (upstream #1196, commit `5dd7f88`;
  their error-logging `cmd.Wait()` variant kept over our gosec-motivated
  discard — it checks the error, so the zero-gosec bar holds). Two test
  fixes on top: the fake restart-wait is paced by 1ms — with an instant
  wait the restart loop cycled faster than the test could drain and the
  drop-on-full publish lost the exact stat a test awaited (an upstream test
  race that surfaced here under parallel-suite timing) — and the new tests'
  wait deadlines carry load headroom.
- Hand-merge batch 3:
  - Logging rework (upstream #1172, commit `bbdb55d`): log data moves off
    `/api/events` onto its own `GET /api/events/logs?stream=proxy&stream=…`
    SSE endpoint, so a chatty model can no longer backpressure model-status
    updates. `Server` carries a single `logmon.Group` (proxy/upstream/http
    streams) instead of three monitors; `logToStdout` copies selected
    streams to stdout; per-stream and per-model `/logs/stream/{id}` tails
    are unchanged. The vanilla UI opens a second EventSource for the log
    stream with the same envelope — logs page behavior is identical.
    Restores the three `APILogEvents` tests trimmed during the #1215 port
    (they arrived with this commit, as predicted), plus a fix for an
    upstream race in the no-history test: monitor delivery is asynchronous
    (Write → channel → publish goroutine), so a pre-subscription write
    could arrive as a live event; the test now probe-drains the broadcast
    before subscribing.
- Hand-merge batch 2:
  - docker/unified: vllm-wrapper builds correctly on untagged commits via the
    new shared `lib-release.sh` revision resolver (upstream #1156, commit
    `e054c90`; the kubeswap stage from the upstream diff dropped — no
    kubeswap here). sm_70 (V100) compiled into the CUDA 12 image, with
    upstream's reworked `build-image.sh` adopted wholesale — two-image CUDA
    12/13 layout with per-platform arch tables (upstream #1187, commit
    `0ac43bb`, user-approved supersede; README GPU-support section updated
    to match).
  - Matrix orphan reference renamed and reworked onto upstream's evolution
    of the same #1026 feature: `+undefined` becomes **`+auto:orphans`**,
    with a shared `buildModelSet` root, `SynthesizedOrphans()` accessor and
    richer startup logging (upstream commit `bea6428`). **Breaking** for
    configs using `+undefined` — rename the reference; the semantics are
    unchanged. Our two legacy `*_undefined_test.go` files were superseded
    by upstream's `*_orphans_test.go` (same coverage plus YAML and
    reference-validation cases).
  - semgrep: whole-repo scan now reports zero findings — the #1213
    wol-proxy confirm/loading pages and the capcompat test fixtures carry
    inline `nosemgrep` markers with reasons; `docs/semgrep-suppressions.md`
    updated with the new sites and the `django-no-csrf-token` misfire
    category.
- Hand-merge batch 1 (one small manual resolution each):
  - Requests without (or with a wrong) `Content-Type` to the model POST-JSON
    routes are tolerated — the body is normalized before the model lookup and
    filters parse it (upstream #1194, commit `486376e`; extended to the
    Anthropic/Ollama translated chains so the same sloppy clients translate
    too — covered by a no-content-type `/v1/messages` test).
  - Browser-generated headers (`Sec-Fetch-*` and friends) are stripped before
    proxying to peers (upstream #1215, commit `d34ddb2`; the conflicting test
    hunk presupposed #1172's separate log-stream endpoints and was trimmed —
    the assertions return when #1172 lands).
  - Decision-model detection: llama-server models whose listing reports only
    decision output are detected automatically (clef fixtures), and
    `decisions` joins the valid output modalities (upstream #1220, commit
    `b51dde4`).

### Changed

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
