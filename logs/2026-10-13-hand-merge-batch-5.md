# 2026-10-13 — Hand-merge batch 5 (voices override, gopsutil fix)

## Goal

Upstream catch-up after the not-covered audit: 163fd1d (#1225 voices) and
a2bf16e (#1180 gopsutil panic fix — previously missed).

## Change

- 163fd1d: Go applied clean; schema = both-additive merge (fixed a missing
  `},` from the splice); KB from theirs; Svelte dropped; ported its one
  user-visible bit — removed the speech tab's `(refresh)` dropdown entry
  (dedicated refresh button already exists).
- a2bf16e: hand-applied ONLY the gopsutil replace directive (their hunks
  carried tailcat deps); `go mod tidy` regenerated go.sum for our set.

## Verification

- suite 1991/32 ok; selftest 167/167; gosec 0 ×3; aidc-scan --all clean.
- E2E: /v1/audio/voices?model=tts answered from config, model never
  started (log-checked).

## Notes

- Gotcha (again): rebuild build/llama-swap before any runtime smoke — the
  first voices smoke hung because the running binary predated the pick.
- Upstream delta after this batch: only tailcat (3), kubeswap (3, incl.
  new #1224), changelog/release tooling (12), and their AGENTS.md — all
  intentionally out. Nothing portable remains.
