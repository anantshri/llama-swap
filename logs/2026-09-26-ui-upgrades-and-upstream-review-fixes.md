# 2026-09-26 — UI upgrades (models/search, capability pickers, stats split, log concerns) and upstream-review fixes (hw + perf)

## Goal

1. Models tab: collapse model descriptions (expandable) and add a search box.
2. Playground: capability-bound tabs should default their model picker to
   models that fit the tab.
3. Stats page: split usage into two tables — active (configured) vs
   inactive/removed models.
4. Logs page: a concerns filter (WARN/ERR/ERROR/CRASH …) to surface issues.
5. Review upstream PRs #1158 and #1159 (both carry this fork's code) and
   apply every valid review finding to our copies.

## Diagnosis

- The models list re-renders on every `modelStatus` SSE event
  (`models.subscribe(renderList)`), so expanded-description state and search
  text cannot live in the re-rendered DOM: state was hoisted to the panel
  instance (a `Set` for expanded ids; the search input placed in the header,
  outside the re-rendered `listEl`).
- `ModelSelector` already accepted a per-tab `match` predicate but only
  sorted fitting models to the top; tabs needed them hidden by default with
  an escape hatch.
- Stats rows record canonical model ids (swaputil resolves aliases via
  `cfg.RealModelName`), so partitioning against current config ids + aliases
  from `/v1/models` (`meta.llamaswap.aliases`) plus the SSE store (which
  also knows unlisted models) is sufficient.
- Log lines: proxy log uses logmon's `[LEVEL]` format; upstream output is
  arbitrary model-server text; access-log lines carry `" 4xx "`-style
  statuses. One combined case-insensitive regex covers all three.
- PR #1158/#1159 files exist byte-identical in this tree, so review
  findings were checked line-by-line against our sources: both #1159 P1s
  and most #1158 findings are real here; the `0xE209` → "Arc B580" model
  claim conflicts with the table's unambiguous-only policy and other
  sources, so it was intentionally skipped.

## Change

UI (hand-authored vanilla JS/CSS under `internal/server/ui_dist/`):

- `js/components/modelsPanel.js` — collapsed descriptions with chevron
  toggle (`expandedDescriptions` Set + `data-desc-toggle` click handling in
  the delegated list handler, toggled in place without a re-render);
  `filtered()` gained a `matches` predicate (id/name/description/alias);
  peer groups whose name matches keep all their models; Profiles/Selectors
  cards hidden while filtering; query-named empty state; search input in
  the panel header.
- `js/components/modelSelector.js` — `fitsOnly` starts true when a `match`
  is given; footer `data-cap-toggle` button flips it ("Show all models
  (N hidden)" / "Show fitting models only"); empty state differentiates
  "No models fit this tab".
- `js/pages/stats.js` — two tables (Active/Inactive) with shared sort;
  `fetchActiveIds()` fetches `/v1/models` once into `listedIds`,
  `recomputeActiveIds()` merges the SSE store; `models.subscribe(refresh)`
  guarded by a `loaded` flag; per-table count labels; inactive table hidden
  when empty.
- `js/components/logPanel.js` — persistent `showConcerns` toggle +
  `CONCERNS_RE` line filter, composed with the existing regex filter;
  warning-triangle button swaps filled/outline icon by state.
- `css/app.css` — `.models-search`, `.model-desc(-text/-toggle/--open)`,
  `.pg-model-all`, `.stats-table-title/-count/-hint`, `.logpanel-btn-on`.
- `__selftest.html` — harness gained `notToContain`; +11 component tests
  driving the real panel/picker/logpanel/stats with observable stores and a
  monkey-patched `fetch` for the stats page.

Go (review fixes):

- `internal/perf/monitor_sysfs.go` — `readFdInfo` attributes records via
  `drm-pdev`, falling back to the render node's sysfs PCI address
  (`renderNodeAddress`, cached); unattributable records skipped when
  discovery marked the host `ambiguous` (>1 GPU); VRAM counted once per
  `drm-client-id` per poll.
- `internal/hw/intel_linux.go` — empty-BDF detail no longer errors before
  the listing-BDF fallback; `CapacityBytes` gated on non-integrated;
  generic `Intel(R) Graphics…` names replaced by PCI-table model.
- `internal/hw/intel.go` — Battlemage G21 gains `0xE215`.
- `internal/hw/intel_linux_test.go` — absent-tool test pins `PATH`;
  dead `xpusmiListing` const removed.
- `internal/perf/monitor_unix.go` — dead `readSysfs` stub removed.

## Commands

```
pip install --break-system-packages playwright
python3 -m playwright install chromium          # headless shell download
sudo apt-get install -y libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 \
  libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 \
  libxcb1 libxkbcommon0 libasound2t64 fontconfig fonts-liberation
go build -o build/llama-swap .
setsid nohup build/llama-swap -config /tmp/opencode/min-config.yaml \
  -listen 127.0.0.1:8765 &                      # serves /ui/__selftest.html
python3 /tmp/opencode/run_selftest.py           # playwright driver
gofmt -l internal/perf internal/hw              # clean
go test ./internal/perf/ ./internal/hw/ -count=1 -cover
make test-dev && make gosec && aidc-scan
```

## Verification

- `__selftest.html`: **146/146** in headless Chromium (was 135; +7 models
  panel, +2 picker capability, +1 log concerns, +1 stats split).
- `go test ./internal/perf/ ./internal/hw/` ok; new regression tests:
  `TestSysfs_DuplicateClientVramCountedOnce`,
  `TestSysfs_FdinfoWithoutPdevResolvedViaSysfs`,
  `TestSysfs_UnattributableFdinfoSkippedOnMultiGpu`,
  `TestHardware_IntelXPUSMIGenericNameReplacedByMappedModel`, integrated
  nil-capacity assertion, `0xE215` arch test.
- `make test-dev`: all packages ok; staticcheck (freshly installed) clean
  in touched files; remaining U1000s pre-existing in untouched
  `d3dkmt_windows.go`/`apple.go`.
- `make gosec`: 0 issues. `aidc-scan`: clean.
- Coverage: perf 61.9%, hw 67.3% (uncovered = platform-specific files).

## Notes

- Environment gotchas, documented for future sessions:
  - `pkill -f "<pattern>"` from a bash tool command kills the tool shell
    itself when the command line contains the pattern — use
    `fuser -k <port>/tcp` instead.
  - Background servers must be started with `setsid nohup …& disown`;
    plain `(cmd &)` jobs get reaped when the tool command exits.
  - Chromium is unusable without fontconfig+fonts (skia FATAL:
    `SkFontMgr_FontConfigInterface`), and needs the t64 apt variants on
    this Ubuntu.
  - The served UI is embedded at compile time (`go:embed`) — rebuild the
    binary before every browser run.
- Upstream PR #1159's two P1 findings and #1158's valid findings are fixed
  in this tree first; the upstream branches should be updated from here.
- Errors hit along the way: arrow-function `arguments` in the fetch stub,
  a `loaded` flag referenced before declaration (strict mode), wrong
  fixture depth in the multi-GPU fake sysfs (5-component path with a
  relative 5-up driver symlink), and CHANGELOG section restructuring — all
  caught by the selftest run or direct inspection before finishing.
