# 2026-10-12 — Hand-merge batch 4 (loading progress, d3ab665 #1212)

## Goal

Final queue item. User instruction: with vanilla-UI work, pay close
attention and keep the code simple — no overcomplication.

## Change

- Pick d3ab665: Go side fully clean (progress parsing from 503 health
  bodies, ProcessLoadingEvent → modelStatus SSE re-send per tick,
  loadingProgress/loadingMessage fields, KB docs for upstream authors);
  Svelte files git rm'd.
- Vanilla port (minimal by design):
  - util/modelUtils.js: loadingPercent (floor+clamp, starting-only) +
    loadingMessage helpers.
  - modelsPanel State cell: percent text, truncated message, 2px bar
    inside the cell (row-wide bar impossible in a <tr> without invalid
    HTML; skipped rather than worked around).
  - modelDetail head: percent + message.
  - 5 CSS rules; zero new components/stores/timers — SSE drives updates.
- One nosemgrep marker on the new loading_progress_test fixture write
  (documented FP category).

## Verification

- E2E: fake upstream 503 {"progress":0.5,...} on /health → modelStatus
  SSE carries loadingProgress/loadingMessage while starting (captured
  event stream inspected); UI render covered by 4 new selftests → 156/156.
- go test -short ./... green; gosec 0 ×3; aidc-scan --all clean.

## Notes / gotchas

- The `pkill -f <pattern>` gotcha bit again (pattern matched the tool
  shell's own command line — the 2026-09-26 log documents it); use
  `kill <pid>` or fuser by port instead.
- Compound commands mixing server kill + build + restart hit tool
  timeouts mid-build; keep build and start as separate commands.
- Upstream survey is now FULLY drained: every portable commit since the
  7a14664 baseline is either landed, intentionally N/A (tailcat, kubeswap,
  changelog/release tooling, upstream AGENTS.md, version bumps), or
  superseded (see DETAILED_CHANGELOG batches 1-4).
