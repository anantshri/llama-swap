# Detailed Changelog

Long-form, dated entries — what / why / how / verification — newest first.
High-level summaries live in [CHANGELOG.md](CHANGELOG.md).

---

## 2026-09-26 — UI upgrades (models/search, capability pickers, stats split, log concerns) and upstream-review fixes (hw + perf)

### Addendum (same day): GPU telemetry saw-tooth fix

Live diagnosis on dumbo (`/api/performance`): while generating
(util 94–98%), `temp_c`/`vram_temp_c`/`fan`/`power_draw_w` hit 0 in
roughly every other 5s sample — e.g. `temp 70, power 261 → all 0 → temp
70, power 260` — while `gpu_util_pct`/`mem_used_mb` stayed healthy. Root
cause: the healthy numbers come from DRM fdinfo (`/proc`, never touches
the device), while hwmon passes fail entirely when the xe card is
runtime-suspended mid-wake; `poll()` published the zeroed sample as-is.
Fix in `internal/perf/monitor_sysfs.go`: `readHwmon` returns success and
retries once after 100ms (the first read kick-starts the resume),
last-known values are carried forward for up to `telemetryHold` (30s,
power only while active), and `lastHwmonAt` advances only on success so a
failed pass is retried next tick. Tests: `TestSysfs_HwmonThrottledWhileActive`
reworked to prove carried values vs re-read (sensor value changed under
the throttle window), plus `TestSysfs_HwmonFailureCarriesLastKnown` and
`TestSysfs_TelemetryHoldExpiry`. Deploying the fix requires rebuilding and
restarting the binary on the affected host.

### Goal

Four UI requests plus a review pass over two upstream PRs (#1158 hardware
detection, #1159 sysfs GPU stats) that carry this fork's code: apply
everything the bot reviewers found that is real in our tree.

### UI changes (all in `internal/server/ui_dist/`, hand-authored)

- **Models dashboard** (`js/components/modelsPanel.js`, `css/app.css`):
  descriptions render collapsed (single line, ellipsis) behind a chevron
  button; expanded state lives in a per-panel `Set` so the SSE-driven
  re-renders (one per modelStatus event) don't collapse it again. A filter
  box under the header matches id/name/alias/description case-insensitively;
  peer groups whose name matches show all their models; Profiles/Selectors
  cards hide while filtering; empty state names the query.
- **Playground pickers** (`js/components/modelSelector.js`): tabs that pass
  a capability `match` (image/audio/speech/rerank) now start with
  `fitsOnly = true` — the dropdown lists only capable models, with a footer
  toggle "Show all models (N hidden)" / "Show fitting models only". Empty
  state says "No models fit this tab" when appropriate.
- **Stats page** (`js/pages/stats.js`): two tables — Active Models (ids from
  `/v1/models` incl. `meta.llamaswap.aliases`, unioned with the SSE models
  store so unlisted models count) and Inactive Models (usage history for
  removed/renamed models). Shared sort state across both headers; inactive
  table hides when empty; SSE modelStatus triggers a local recompute (the
  `/v1/models` listing is fetched once, guarded by a `loaded` flag so the
  subscribe-time immediate fire doesn't race the boot render).
- **Log panels** (`js/components/logPanel.js`): persistent `concerns` toggle
  filtering lines via a combined regex — bracketed levels, severity words,
  and `" 4xx "/" 5xx "` access-log statuses; composes with the text regex.

### Review-driven fixes from upstream PRs #1158 / #1159

Both PRs contain code that already lives in this fork; the Greptile/CodeRaby
findings were verified line-by-line against our copies and the real ones
fixed:

- `internal/perf/monitor_sysfs.go` — (P1) fdinfo records without
  `drm-pdev` matched every GPU: now attributed via the render node's sysfs
  device link (cached per node), and skipped on multi-GPU hosts
  (`ambiguous` flag set by discovery) when unresolvable. (P1) duplicated
  fds sharing a `drm-client-id` double-counted VRAM: count once per client
  per poll. (P2) tests renamed to `TestSysfs_<case>`.
- `internal/hw/intel_linux.go` — detail response with empty BDF no longer
  errors before the listing-BDF fallback; integrated GPUs keep
  `CapacityBytes` nil (borrowed system RAM was published as VRAM); generic
  `Intel(R) Graphics [0x…]` names yield to the PCI-table model.
- `internal/hw/intel.go` — Battlemage G21 gains `0xE215` (per
  intel/compute-runtime). The reviewer's claim that `0xE209` maps to
  "Arc B580" was NOT applied: sources conflict and the table's documented
  policy is unambiguous models only.
- `internal/hw/intel_linux_test.go` — `TestHardware_IntelXPUSMIAbsent` now
  pins `PATH` to an empty temp dir instead of assuming the host lacks
  xpu-smi; dead `xpusmiListing` const removed (staticcheck U1000).
- `internal/perf/monitor_unix.go` — removed the dead `readSysfs` stub
  (superseded by `trySysfs` in monitor_sysfs.go).

### Verification environment

No browser existed in the container; `pip install --break-system-packages
playwright` + `python3 -m playwright install chromium` + the needed apt
packages (`libglib2.0-0t64 libnss3 … libxkbcommon0 libasound2t64
fontconfig fonts-liberation` — skia FATAL-crashes without fontconfig)
gave a working headless Chromium. The selftest runs against a real server
(`go build -o build/llama-swap . && setsid nohup build/llama-swap …`) since
`/ui/...` module paths are absolute; `setsid` is required — plain `&`
background jobs get reaped when the tool shell command exits.

### Verification

```
__selftest.html (headless Chromium)   # 146/146 — +11: models panel ×7,
                                      # picker capability ×2, log concerns ×1,
                                      # stats split ×1
go test ./internal/perf/ ./internal/hw/ -count=1   # ok (3 new perf tests:
                                                   # dup-client VRAM, pdev-less
                                                   # via sysfs, multi-GPU skip)
make test-dev                         # all packages ok; staticcheck clean in
                                      # touched files (remaining U1000s are
                                      # pre-existing in d3dkmt/apple, untouched)
make gosec                            # 0 issues
aidc-scan                             # semgrep + gitleaks + gosec clean
go test -cover                        # perf 61.9%, hw 67.3%
```

### Notes

- The review comments should also be answered upstream: #1159's two P1s are
  real and fixed here; #1158's findings are fixed except the `0xE209`
  model-name claim (intentionally skipped, see above).
- The stats "active" set treats a model as active only if `/v1/models` or
  the SSE store knows it; if BOTH are unavailable the page falls back to the
  old single-table behaviour (everything active) rather than hiding rows.

---

## 2026-09-25 — Parts view: collapse/expand controls and pretty-printed tool payloads

### Goal

Operator feedback on the merged parts view:

1. Long contexts produce dozens of part blocks, all open — a scroll marathon.
   Add `Collapse all` / `Expand all` next to Copy.
2. Tool results arrive as one-line JSON blobs inside the boxes; render them
   pretty-printed.

### How

`internal/server/ui_dist/js/components/captureDialog.js`:

- `prettyIfJson(text)` (exported): when text parses as JSON it is re-rendered
  with 2-space indent; anything not JSON-shaped passes through untouched.
  Applied to `role:"tool"` message content, Responses-API
  `function_call_output.output`, and `tool_use` content-part inputs (the
  latter via the existing `prettyArgs`). Char/word/token counts are computed
  from the rendered text, so they track the pretty form.
- `requestPartsHTML(parts, {open})` — `open: false` renders every
  `<details>` block without the `open` attribute (default unchanged: open).
- Dialog state gains `partsOpen` (`undefined` = expanded default, reset per
  capture in `open()`); the request tab row shows `Collapse all` /
  `Expand all` buttons only while the Parts tab is active; clicking sets
  `partsOpen` and re-renders, so the choice survives the Copy button's
  "Copied!" re-render. Copy still copies the full text regardless of
  collapse state.

### Verification

```
__selftest.html (headless Chromium)   # 119/119 — 6 new tests:
                                      #   open option, prettyIfJson (JSON /
                                      #   non-JSON / empty / null), tool
                                      #   result pretty, plain-text result
                                      #   untouched, function_call_output
                                      #   pretty, tool_use input pretty
headless dialog drive                 # buttons render; 3/3 open → Collapse
                                      # all → 0 open → Expand all → 3 open;
                                      # tool result pre carries the indented
                                      # JSON; no page errors
```

---

## 2026-09-25 — UI ports: live chat stats (#1099), profile controls (#1170), Help topics (#1088), responsive chat (#1120)

### Live generation stats (#1099)

- `js/api/chat.js`: requests `stream_options.include_usage` (OpenAI) and
  llama.cpp's `timings_per_token`; `normalizeUsage` accepts OpenAI and
  Anthropic spellings incl. cached-token variants, `normalizeTimings` maps
  llama.cpp `prompt_n + cache_n` timings; all three stream parsers now emit
  `usage` on chunks. Sampling params `top_k` / `top_p` / `min_p` are plumbed
  into the request bodies (responses API: `top_p` only).
- `js/util/generationStats.js` (new, harness-tested): per-turn tracker with
  prompt/decode phase clocks, reasoning/answer chunk split, draft-token
  counts; chunk-based estimates are replaced by real usage when reported.
  `formatStatsLine` renders one readable line.
- `chatInterface.js` / `chatMessage.js`: live stats line under the streaming
  answer, frozen per-turn stats after completion; cancelled turns are marked
  "stopped".

### Profile mappings (#1170)

`modelsPanel.js` profile rows resolve their target against the model list:
live status dot (local only), link to the model detail page, Load/Unload
buttons reusing the panel's delegated handlers. Peer targets link without
controls; unresolved/disabled render as before.

### Help agent topics and controls (#1088)

`agent/docsSuggestions.js` (new): 37-question curated pool +
`pickSuggestions` (Fisher-Yates). The Help empty state offers 4 random topics
with a "New topics" refresh button and streamlined copy. Agent loop limit
8 → 16 iterations. Stale speculative-decoding KB article removed; docs search
description now cites "Docker health check" instead of draft models.

### Responsive chat (#1120)

Settings panel capped at `min(60vh, 26rem)` with internal scrolling, so a
large system prompt no longer stretches the page; system textarea gets a
bounded vertical resize; the three sampling params share a compact row;
mobile breakpoint tightens gutters and wraps the param row.

### Verification

```
go test -short -count=1 ./internal/server/ ./internal/docagent/  # ok
__selftest.html (headless Chromium)   # 135/135 across the batch
headless drives: combobox filter+select, agent-work counters/expansion,
fetch capture proving the request body carries stream_options,
timings_per_token, top_k/top_p/min_p; no page errors
```

### Notes

- `make eval-docs-agent` still needs a live model (see 2026-09-24 jq entry).
- The remaining upstream deltas are the tailcat stack (internal + #1091 UI)
  and the decision-skipped items (store split, kubeswap, release tooling,
  docker images).

---




## 2026-09-25 — UI ports: searchable model picker (#1153) and stable Work header (#1101)

### Model picker combobox (#1153)

`internal/server/ui_dist/js/components/modelSelector.js` rewritten from the
`<select>` dropdown into a search combobox: click or typing opens the list,
the query filters local models/aliases/peers in real time, ArrowUp/Down +
Enter + Escape navigate, outside pointerdown closes. Optional per-tab `match`
predicate floats models that fit the tab's needs to the top (marked ◆):
audio (audio input / transcriptions / speech), image (image output /
generation / image-to-image), speech, rerank. Model records in `api.js` now
carry `architecture` modalities for those checks. Pure helpers
`buildModelOptions` / `filterModelOptions` live in `util/modelUtils.js`.

### Stable Work header (#1101)

`internal/server/ui_dist/js/components/agentWork.js` now renders one
collapsible **Work** section per assistant response instead of a flat item
list. The collapsed header shows stable counters — reasoning characters ·
duration · tool-call count — with a spinner only while work runs; the label
never switches with the current item, so nothing flickers. Expansion state is
tracked across the frequent re-renders while streaming (click-driven, since
the `toggle` event fires after the default action and would restore stale
state).

### Verification

```
__selftest.html (headless Chromium)   # 135/135 — +3 picker option/filter tests
headless drive: combobox              # type "whi" filters to whisper; Enter
                                      # selects; input shows the selection
headless drive: agent work            # counters identical working vs done;
                                      # spinner toggles; expansion survives
                                      # re-renders; no page errors
```

---

## 2026-09-25 — Port upstream small-fix batch 2 (#1165, #1090, #1145, #1089)

### Goal

Final cheap wins from the upstream survey: cmdStop output logging, vllm
wrapper timeout cleanup, the comfyui endpoint rework + guide, and the Docs
Agent max_tokens raise. (Branch tip was first cleaned of a test README
commit by the operator.)

### What was picked

| Upstream commit | PR | Change |
|---|---|---|
| `e1526c8` | #1090 | vllm-wrapper: drop the custom `http.Transport`, use Go's default timeouts. Conflict resolved by removing the transport while keeping the fork's CORS comment on `ModifyResponse`. |
| `111d2d3` | #1165 | `cmdStop` stdout/stderr now go to the process logger; `WaitDelay` bounds the pipe copy so a backgrounded child cannot hang `Run()`; `ErrWaitDelay` is a warning. Conflict: kept the fork's `#nosec G204` line on `exec.Command`, added upstream's wiring. |
| `29d10df` | #1145 | ComfyUI handlers moved from `api.go` into `comfyui.go` (+282-line test suite); root-only start rule replaced by `comfyUIIgnorePaths` (static assets, `/ws`, `/api/jobs` — GET only, writes still start the model); 178-line KB guide; targeted swap-restriction patterns. `api.go` conflict resolved to upstream's deletion — its version strictly supersedes the fork's. |
| `8365956` | #1089 | Docs Agent max_tokens 4096 → 65536; hand-ported as a one-liner to `docsInterface.js` (upstream's Svelte/CLI half N/A). Long agent answers were being truncated at 4k. |

### Security-gate follow-ups

- gosec G710 fires on the moved `/comfyui/` redirect; suppressed at the exact
  line in `comfyui.go` (same false-positive verdict as before) and
  `docs/gosec-suppressions.md` updated: the site is now
  `internal/server/comfyui.go`, not `api.go`.

### Verification

```
go test -short -count=1 ./internal/... ./cmd/vllm-wrapper/  # all ok
make test-dev                                               # ok; same 4
                                                            # pre-existing staticcheck
make gosec                                                  # 0 issues
aidc-scan                                                   # semgrep/gitleaks clean
__selftest.html (headless Chromium)                         # 113/113
```

### Notes

- These commits are unsigned (container has no signing key); the operator
  re-signs the tip with the established
  `git rebase main --rebase-merges --exec 'git commit --amend --no-edit -S'`.
- With this batch, every small/medium upstream commit is ported. Remaining
  upstream deltas are the decision-gated ones: store interface split
  (`aecf92e`), kubeswap (`c5753ce`+), the tailcat stack, release tooling,
  docker images, and the agreed-last UI ports.

---

## 2026-09-24 — Port upstream jq-backed get_config for the Docs Agent (#1087)

### Goal

Fifth batch of the upstream survey: replace the Docs Agent's path-based
`get_config` with a jq query (upstream `a77f107`, updates upstream #1085) —
a large multi-model config no longer has to be paged through whole.

### How

- `internal/config/mcpprovider.go` (auto-merged): `get_config` evaluates a
  jq expression (gojq) against the running, credential-redacted config.
  Hardening, all carried over from upstream: 5s evaluation timeout, 200k
  value-node cap, 32 KB rendered-result cap, and a heap-growth guard
  (128 MiB, sampled every 10 ms) that can stop unbounded constructs like
  `[range(0; 5000000)]` — relevant because `/api/mcp` needs no credentials
  by default.
- `internal/server/apimcp.go` wiring + 300 lines of provider tests + a
  config eval-fixture helper landed with it.
- `evals/docs-agent/`: new jq cases (incl. holdout), fixture models, and an
  updated `run.sh`.
- `docs/kb/`: mcp-endpoint guide and README updated for the new tool.

### Adaptations for the fork

- Upstream's Svelte UI half of the commit (`ui/src/**` — Help page move,
  playground stores, suggestion lists) was dropped entirely: the fork's UI
  is hand-authored vanilla JS under `internal/server/ui_dist/`.
- The agent-facing prompt text was ported by hand instead: the fork keeps
  the Docs Agent system prompt in
  `internal/server/ui_dist/js/agent/docsAgentPrompt.js`, whose
  `config__get_config` bullet now documents the jq query form with the same
  examples upstream uses.
- `AGENTS.md` conflict resolved to the fork's version (upstream's change
  only renamed the Svelte page hosting the agent).
- `go.mod`: `github.com/itchyny/gojq v0.12.19` (+ `timefmt-go` indirect)
  added to the fork's dependency set; upstream's klauspost/compress bump
  not taken.

### Verification

```
go test -short -count=1 ./internal/...   # all ok, incl. new provider tests
make test-dev                            # ok; staticcheck: same 4 pre-existing
make gosec                               # 0 issues
__selftest.html (headless Chromium)      # 113/113; docsAgentPrompt.js imports clean
```

### Notes

- `make eval-docs-agent` (scoring the agent against a local model) could not
  run in this environment — it needs a llama-swap-served model. Run it once
  where a model is available to confirm the new cases pass.
- The UI-side Help page did not change: the fork's docsInterface.js already
  talks to `/api/mcp`, whose tool contract changed transparently.

---

## 2026-09-24 — Port upstream capcompat: automatic capability discovery (#1083/#1105)

### Goal

Fourth batch of the upstream survey: `internal/capcompat` (upstream `eeac3e6`,
the largest port at ~3.8k lines / 43 files) — automatic context and modality
discovery from upstream servers, cached across restarts.

### How it works (upstream design, adapted)

- On process `Ready`, the server probes the model's own proxy address
  (`capcompat.NewClient`) — never through the router, so TTL windows and
  concurrency slots are untouched — on its own goroutine.
- Adapters parse llama-server `/props` + `/v1/models`, vLLM `/v1/models`
  (incl. LoRA), and halogen `/health` + `/v1/models`.
- Results are stored via the store's new generic key/value cache
  (`cache` table) and survive model unload / proxy restart.
- `/v1/models`, the dashboard listing, and aliases resolve capabilities as
  `config.Merge(auto)`: configured values win field-by-field; a model with
  `capabilities.disableAuto: true` is never probed.
- A `ModelCapabilitiesChangedEvent` is emitted when a probe learns something
  new, so UI clients re-pull the listing.

### Adaptations for the fork

- Upstream's store is split (`internal/store` + `internal/store/sqlite`);
  the fork keeps its single-file store. The `CacheRepository` interface
  (`internal/store/cache.go`) landed as-is; the sqlite implementation was
  folded into `internal/store/store.go` as methods on `*Store`
  (`Cache()` returns the store itself), cache rows are pruned on start, and
  upstream's cache tests were moved into `package store`.
- Upstream's `00003_create_cache.sql` was renumbered to
  `00004_create_cache.sql` (the fork already has its own
  `00003_activity_src.sql` from the forwarded-headers port); the partial
  `internal/store/sqlite/` package was deleted.
- `ModelCapConfig` kept the fork's #915 fields (`max_output_tokens`,
  `reasoning`) and gained upstream's json tags, `disableAuto`, and `Merge`.
- `apigroup.go` keeps the fork's 10-value `renderCapabilities` signature but
  now renders the *resolved* capabilities.
- gosec G104 in `capcompat.go` (unhandled drain on the error path) fixed with
  `_, _ =` + comment.

### Verification

```
go test -short -count=1 ./internal/...   # all ok, incl. capcompat 517-line
                                         # test suite + store cache tests
make test-dev                            # ok; staticcheck: same 4 pre-existing
make gosec                               # 0 issues (after G104 fix)
aidc-scan                                # semgrep/gitleaks/gosec clean
__selftest.html (headless Chromium)      # 113/113, no page errors
```

### Notes

- `store.New` now runs `Cache().Prune(ctx)` at startup — in-memory stores
  start empty, file stores drop rows that expired while the process was down.
- The `cache` table is a general-purpose key/value API (callers own the key
  namespace); capcompat is its first user.
- Migration numbering: this fork's migrations diverge from upstream's
  (fork: `00003_activity_src`, `00004_create_cache`). Future ports touching
  migrations must renumber accordingly.

---

## 2026-09-24 — Port upstream global concurrency semaphore (#1110)

### Goal

Third batch of the upstream survey, per the agreed order (CORS → concurrency
semaphore → capcompat → jq config → kubeswap): `globalConcurrencyLimit`, a
top-level cap on concurrent inference requests across all models
(upstream `41ec321`, fixes upstream #1086).

### How

- `internal/server/concurrency.go` (added clean): token semaphore built on
  `golang.org/x/sync/semaphore`; `CreateConcurrencyLimitMiddleware(limit)`
  rejects with HTTP 429 (Retry-After honoured) once the limit is reached —
  requests are never queued.
- `internal/server/server.go`: the middleware joins `modelMWs` (top of the
  inference chain, right after auth) only when the limit is > 0, so a default
  config pays nothing.
- `internal/config`: `GlobalConcurrencyLimit int` field (fork's struct kept
  as-is otherwise), load-time validation `>= 0`, config test + schema +
  `docs/config.example.yaml` + capacity-and-queues guide landed from upstream
  automatically.

### Conflicts / adaptations

- `AGENTS.md`: upstream rewrote it for its own workflow — kept the fork's
  version in full.
- `go.mod`/`go.sum`: kept the fork's dependency set; promoted
  `golang.org/x/sync` to a direct dependency at upstream's `v0.22.0`
  (fork had v0.21.0 indirect) and ran `go mod tidy`. Upstream's x/sys bump
  was not taken.
- `internal/config/config.go`: fork's Config struct kept; only the new field
  added (upstream also regrouped fields and carries tailcat runtime state).
- `internal/docagent/golden_test.go`: expected config-example sections now
  include `globalConcurrencyLimit` alongside the fork's `security`/`pricing`.

### Verification

```
go test -short -count=1 ./internal/...   # all ok, incl.
                                         # TestServer_GlobalConcurrencyLimit
make test-dev                            # ok; staticcheck: same 4 pre-existing
make gosec                               # 0 issues
aidc-scan                                # gitleaks clean (tree committed)
```

### Notes

- The fork's `experimental-concurrency-refactor` branch predates this; the
  upstream semaphore is now the supported global cap. That branch should be
  reassessed (likely rebased or retired) rather than merged as-is.
- Interaction to know: the semaphore guards the inference chain only —
  /api, UI, health endpoints are not counted against the limit.

---

## 2026-09-24 — Port upstream CORS controls (#1133); browser self-test green

### Goal

Second batch of the upstream survey: the CORS hardening (biggest of the
"bigger features", done first per the agreed order) plus getting the
in-browser self-test runnable in this environment.

### Browser test setup

- Installed Playwright + Chromium (headless shell 153) in `/tmp/opencode/venv`
  with OS deps via `playwright install-deps`.
- Self-test served over HTTP (ES modules need a real origin):
  `ui_dist` symlinked as `/tmp/opencode/serve/ui`, `python3 -m http.server`.
- Result: **113/113 passed — all green**, no page errors. This is the first
  real-browser verification of the merged PR #25 (107 tests) plus this
  session's 6 M1/L2 tests.

### CORS port (upstream `769dbac`, + `6c36b88` follow-up)

Conflicts/adaptations (fork has no tailcat, no kubeswap, no global
concurrency limit yet, and keeps its own pricing block):

- `cmd/kubeswap/serve.go` hunk dropped (`git rm`) — kubeswap not ported yet.
- `cmd/vllm-wrapper/main.go`: kept the fork's custom transport, took
  upstream's updated comment (headers now stripped by llama-swap).
- `config-schema.json`: kept fork `pricing` + added upstream `security`.
- `docs/config.example.yaml`: added `security` example, dropped the tailcat
  example.
- `internal/config/config.go`: added `Security SecurityConfig`, dropped
  upstream's `tailcatEnabled` runtime state.
- `internal/docagent/golden_test.go`: expected-sections list gained
  `security` only (not `tailcat`/`globalConcurrencyLimit`).
- `internal/server/auth.go`: old hardcoded permissive `CreateCORSMiddleware`
  and its sanitize helpers deleted — replaced by new `cors.go` (added clean).
- `internal/server/server_test.go`: ported upstream's
  `newTestServerWithConfig` helper (adapted to the fork's `store.New`),
  dropped the obsolete `TestServer_CORSPreflight`.
- `6c36b88` is an ancestor of `769dbac` upstream; its auth.go fix is already
  superseded by `cors.go`, but its `api.go`/`api_test.go` hunks still matter:
  the `/api/tags` Origin echo was removed (redundant in permissive mode and a
  bypass of `allowedOrigins` in restrictive mode), with the actual-response
  regression test added.

### Security-gate cleanup (`aidc-scan --all`)

Pre-existing findings surfaced by the first full-repo scan, fixed:

- `internal/server/captures_test.go`: `math/rand` → inline deterministic
  xorshift64 (keeps reproducibility, drops the flagged import).
- `docker/build-container.sh`: quoted `cd`, loop-based ARCH check (SC2199/
  SC2076/SC2145), `local`/assign separation (SC2155).
- `scripts/uninstall.sh`: quoted `command -v` instead of unquoted `which`.

### Verification

```
go test -short -count=1 ./internal/...   # all ok
make test-dev                            # ok; staticcheck: same 5 pre-existing
                                         # findings (internal/perf, server.go,
                                         # swaputil) — untouched by this session
make gosec                               # 0 issues
aidc-scan --all                          # all scanners clean
__selftest.html (headless Chromium)      # 113/113, no page errors
```

### Notes

- staticcheck's 5 pre-existing findings remain open and predate this session
  (`d3dkmt_types.go` unused fields, `monitor_unix.go` `readSysfs`,
  `server.go:283` TrimPrefix, `swaputil/http.go` unused assignment) — flagged
  for a separate decision, since the perf code is Windows/sysfs-specific.
- Upstream also strips CORS headers in the peer proxy and kubeswap; the peer
  hunk landed as part of `769dbac` (staged file `internal/router/peer.go`).

---

## 2026-09-24 — Upstream ports: forwarded headers, totals-after-prune, TTL, zstd, tabbyAPI

### Goal

Pull five small, high-value upstream fixes into the fork (all Go-side, no UI
impact), per the 2026-09-24 upstream survey (fork main was 37 commits behind
`mostlygeek/llama-swap`).

### What was picked

| Upstream commit | PR | Change |
|---|---|---|
| `8fa8589` | #1104 | tabbyAPI usage extraction (`prompt_tokens_per_sec`, `completion_tokens_per_sec`, `total_time`) |
| `0e1f797` | #1123 | single bounded shared zstd encoder replaces per-core sync.Pool |
| `21bc145` | #1095 | TTL idle window starts when the model is ready, with regression test |
| `2edad4a` | #1130 | `X-Forwarded-For`/`X-Real-IP` support; activity `src` source attribution |
| `96e6f94` | #1136 | stats `TotalRequests` = `MAX(id)` so totals survive pruning |

### Adaptations (upstream base differed)

- `2edad4a` assumed upstream's tailcat and store-split (`internal/store/sqlite/
  activity.go`) work, which the fork has not picked. Adaptations:
  - `activitySource()` in `internal/server/metrics.go` was added **without**
    the `tailcat.SourceFromContext` preference (fork has no tailcat); the
    forwarded-header fallback and `ip:` fallback are verbatim upstream.
  - `forwardedIP()` + `clientIP()` refactor landed cleanly in
    `internal/server/log.go` from the same commit.
  - Persistence was added for the fork's single-file store: `ActivityLogEntry.Src`
    (`json:"src"`), `src` in the activity INSERT/SELECT and sort whitelist
    (`internal/store/store.go`), plus new goose migration
    `00003_activity_src.sql` (`ALTER TABLE activity ADD COLUMN src TEXT NOT
    NULL DEFAULT ''`). Upstream's optional `idx_activity_src_created_id`
    index was skipped — the fork has no src-filtered queries yet.
- `96e6f94` only existed as a diff against upstream's split store; the
  one-line change (`COUNT(*)` → `COALESCE(MAX(id), 0)`) and its regression
  assertions were applied by hand to `ActivityStats` and
  `TestStore_PruneActivity` in the fork's layout, with a comment explaining
  the MAX(id) rationale.

### Verification

```
go test -short -count=1 ./internal/...   # all packages ok
make test-dev                            # go test + staticcheck
make gosec                               # 0 issues (GOOS linux/darwin/windows)
aidc-scan                                # gitleaks clean; semgrep clean on the UI half earlier
```

- staticcheck reports 5 findings, all verified pre-existing on `main`
  (`internal/perf`, `internal/server/server.go:283`, `internal/swaputil`):
  none are in files touched by this session.
- `2edad4a`'s `activitySource`/forwarded-header tests pass unmodified against
  the no-tailcat adaptation.
- The fork's `src` persistence is covered by existing store round-trip tests
  via `InsertActivity`/`ListActivity` and by `TestStore_PruneActivity` for the
  totals change.

### Notes

- `src` values are not yet displayed in the Activity UI; the column is in the
  API payload (`src` JSON key) and sortable. UI display can ride along with
  the upcoming UI-porting round.
- `aidc-scan` scoped run found nothing after commits; it scopes to a dirty
  tree, so the Go half was verified by `make gosec` + gitleaks instead.

---

## 2026-09-24 — Parts view: Responses-API function items and CJK-aware token estimates

### Goal

Follow-ups from the code review of PR #25 (parts view):

- **M1** — Responses-API `input[]` items of type `function_call` and
  `function_call_output` carry neither `role` nor `content`, so
  `splitRequestParts()` silently dropped them, despite responses-API support
  being a headline claim.
- **L2** — the token estimate charged every character at chars ÷ 4, which
  under-counts CJK text roughly 4x (CJK tokenizes at close to one token per
  character).

### How

`internal/server/ui_dist/js/components/captureDialog.js`:

- The message loop gained two early-return branches before the role-based
  handling: `msg.type === "function_call"` pushes a `tool_call` part with the
  decoded arguments (`prettyArgs(msg.arguments)`, label carrying the call
  name); `msg.type === "function_call_output"` pushes a `tool`-role message
  part from `contentText(msg.output)` with the `call_id` in the label. Content
  arrays (`[{type:"output_text",...}]`) flatten via the existing `contentText`.
- `estimateTokens()` now counts CJK characters (Han, Hiragana, Katakana,
  Hangul via a `\p{Script=...}` regex) at one token each and applies chars ÷ 4
  to the remainder; empty text stays 0 and any non-empty text stays ≥ 1. The
  totals note now reads "≈1 per CJK char, other chars ÷ 4".

### Verification

- No Node/Chromium available in this environment, so the changed algorithms
  were verified via a faithful Python transliteration of `estimateTokens` /
  `splitRequestParts` run against the new self-test assertions — all passed
  (CJK rates, mixed CJK/latin, both function-item branches, content-array
  output, request-order preservation, plus regressions for the pre-existing
  request shapes and `null` returns).
- `internal/server/ui_dist/__selftest.html` gained 6 tests (2 CJK estimate,
  4 function-item) — to be exercised by the next headless browser run of the
  self-test harness.
- `make test` passes (UI assets embedded and served unchanged; no Go code
  changed).

### Notes

- `estimateTokens` iterates by code point, so astral-plane characters count as
  one CJK/non-CJK unit while `s.length` counts UTF-16 units — the estimate
  slightly over-counts emoji-heavy text, which is acceptable for a labelled
  approximation.

---

## 2026-09-21 — Activity capture dialog: request-body parts view

### Goal

Issue #24 ("Activity View enhacement"): when a request contains multiple parts,
show them separately — system prompt, user prompt, tool calls — with a word
count and, if possible, a token count for each.

### Why

The capture dialog rendered the request body as pretty-printed JSON only, so a
multi-turn tool-using request had to be read as one blob: the system prompt, the
individual messages, tool calls and the tool schemas were all mixed together and
there was no sense of how the prompt budget was spent across them.

### How

`internal/server/ui_dist/js/components/captureDialog.js` — the UI is hand-authored
ES modules with no build step, so the served files are edited directly:

- `countWords(text)` / `estimateTokens(text)` — words split on whitespace runs;
  tokens are `max(1, chars ÷ 4)`. There is no tokenizer in the tree (the proxy
  only forwards `/v1/messages/count_tokens` upstream), so the estimate is
  labelled as such everywhere it is displayed.
- `contentText(content)` flattens a `content` value — plain string, array of
  typed parts (`text`/`input_text`, `image_url`, `input_audio`, `tool_use`,
  `tool_result`) or arbitrary object — into display text.
- `splitRequestParts(body)` returns `{parts, totals}` with one entry per
  readable piece: top-level `system` and `instructions`, one part per
  `messages[]` item keyed by role, one part per `tool_calls` / legacy
  `function_call` (arguments JSON-decoded and re-indented), one part per tool
  result (label carries the `tool_call_id`), a `tools`/`functions` part for the
  schemas, and the bare `prompt`/`input` of the completions and responses APIs.
  Returns `null` when the body carries none of these (audio, images,
  embeddings, rerank), so the parts tab simply does not appear.
- `requestPartsHTML(parts)` / `requestPartsText(parts)` render the view and the
  plain-text form used by the dialog's Copy button; all model-supplied text goes
  through `escapeHtml`.
- `requestPartsFor(rawBody)` memoizes the parse of the last body so tab switches
  do not re-parse multi-megabyte prompts.
- The Request Body tab row becomes `Parts | Pretty | Raw` for such bodies, and
  `defaultReqTab()` lands multi-part requests on `Parts` (single-part bodies and
  non-JSON bodies keep the previous pretty/raw behaviour). A stale `parts`
  selection falls back to `pretty` if the body has no parts.

`internal/server/ui_dist/css/app.css` styles the parts blocks
(`.capture-parts`, `.capture-part`, role-coloured `.capture-part-role--*`,
monospaced stats line).

### Commands

```
make test                                  # go test -short -count=1 ./internal/...
gofmt -l .                                 # clean
go vet ./internal/server/                  # clean
python3 ../verify24_parts_view.py          # headless Chromium checks
```

### Verification

- `internal/server/ui_dist/__selftest.html` (the repo's in-browser test harness)
  gained 20 tests over `countWords`/`estimateTokens`/`splitRequestParts`/
  `requestPartsHTML`/`requestPartsText`, covering every request shape, the
  tool-call/tool-result labelling, content-array flattening, totals, the
  no-parts `null` return and HTML escaping. Headless Chromium run:
  **107/107 passed — all green**.
- The dialog itself was driven in the same browser session with a synthetic
  capture (system prompt + user + tool_call + tool result + assistant + tool
  schema): tabs render `Parts | Pretty | Raw`, the request lands on `Parts`, the
  six parts carry the expected labels and counts (`6 parts · 189 chars · 30
  words · ≈49 tokens`), switching to Raw and back preserves the parts, and a
  single-message body still opens on `Pretty`. No page errors.
- `make test` (go test -short ./internal/...) passes: the UI is embedded and
  served unchanged (`TestServer_EmbeddedUIAssets`, `TestServer_ServeUI_*`).
- No Go code changed, so `make gosec` is unaffected.

### Notes

- Token counts are an approximation by design. Exact per-part counts would need
  a tokenizer: either a llama.cpp `/tokenize` round-trip per part through a new
  server-side breakdown endpoint, or a bundled tokenizer in the UI. The estimate
  is labelled `≈` and the totals line states the formula, so nobody mistakes it
  for a server-reported number.
- Empty parts are skipped — an assistant turn that only carries tool calls
  contributes its tool-call part, not an empty message part — and a body with no
  recognizable prompt keys returns `null`, so the parts tab stays hidden.
- Follow-up ideas (not implemented): show the server-reported prompt token count
  from the activity row next to the estimate, and offer the same breakdown for
  the response body.

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
