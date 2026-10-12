# 2026-10-12 — Upstream survey + clean cherry-pick batch

## Symptom / goal

User asked to investigate whether anything else can be cherry-picked from
upstream (mostlygeek/llama-swap), then to take the commits that need no hand
merges first.

## Diagnosis — full upstream survey

- Branch under work: `updates-25-sep-26` (merge-base with upstream:
  `7a14664`, 2026-09-01). Upstream/main is 72 commits ahead.
- `git cherry` finds almost no patch-equivalents because prior ports were
  hand-merged; cross-checked content instead (grep for each commit's
  identifiers + DETAILED_CHANGELOG port ledger).
- **Already ported** (no action): capcompat discovery (`11e6169`),
  forwarded-for, CORS port, #1136, #1165, #1145, #1153, #1170, #1158/#1159,
  #1095, #1123, #1104, #1099, #1089, #1087, #1101, #1110; #1177
  (manifest-no-auth) is satisfied by this fork's design — root assets are
  registered without the auth chain (internal/server/server.go:393-396).
- **Still N/A**: tailcat subsystem (#1166, #1169), kubeswap/helm (#1131,
  #1129), upstream changelog/release tooling, AGENTS.md, version bumps.
- **Portable candidates found** (17 items, prioritized table delivered to
  user; see DETAILED_CHANGELOG entry for the conflict-checked lists).

## Change — the clean batch

Cherry-pick dry-run loop in a detached worktree at
`/tmp/opencode/cherry-test` (21 candidates, upstream order, abort on
conflict) → 8 clean. Applied the same 8 with `git cherry-pick -x` on the
real branch:

`aa8031f` #1157 · `a6f3b09` #1182 (docker audio.cpp mp3 + static eSpeak-ng)
`7e18554` #1189 (ComfyUI concurrency floor 999) · `45b78e2` #1197
(/v1/systemone) · `9db37d0` #1198 (capcompat defaultProber) · `783c323`
#1199 (oMLX token rates) · `d60d084` #1205 (per-model disableKeepAlives) ·
`8db9566` #1213 (wol-proxy confirm UI).

Paperwork: CHANGELOG ports section, DETAILED_CHANGELOG dated entry, one new
`.gitleaksignore` fingerprint (gitleaks re-attributed the reviewed tailcat
placeholder to its duplicate-lineage commit `f1d38508`; ledger header already
documents the per-commit convention).

## Commands

```
git worktree add --detach /tmp/opencode/cherry-test updates-25-sep-26
for sha in <21 candidates>; do git cherry-pick -x $sha || git cherry-pick --abort; done
go build ./... && gofmt -l .   # in worktree
go test ./internal/config/ ./internal/capcompat/ ./internal/server/ \
        ./internal/process/ ./cmd/wol-proxy/
# real branch: same 8 cherry-picks, then:
go test -short ./...           # 25 pkgs ok
GOOS={linux,darwin,windows} gosec -quiet ./...
aidc-scan
```

## Verification

- Worktree: 8/8 clean, build + gofmt + touched-package tests green.
- Real branch: `go test -short ./...` all ok; gosec 0 findings ×3 GOOS;
  `aidc-scan` clean (gitleaks clean after the one fingerprint).
- The #1205 process tests skip without `build/simple-responder` — built it
  (`go build -o build/simple-responder ./cmd/simple-responder`) and ran
  them for real.
- Fresh-eyes review caught the #1205 census test failing on this fork
  (`4 vs want 3`): our PR #915 `/props` reasoning probe opens an extra
  upstream connection. Fixed the test to serve `/props` as JSON outside the
  census; all 4 keepalive tests pass (`-count=1`).
- `make` is not on PATH in this container; `make test-dev`'s two steps were
  run directly (`go test -short ./...`; staticcheck not installed, `|| true`
  in the Makefile tolerates it). `make test-all` (long concurrency tests)
  not run — `go test -short` covers the suite.

## Notes

- Uncommitted opik session edits (CHANGELOG/DETAILED_CHANGELOG + 2 untracked
  docs) were stashed around the paperwork commit and restored after —
  untouched, still uncommitted.
- Next batch (needs hand merges, priority order): `a2bf16e` gopsutil panic
  fix, `486376e` content-type autofill, `d34ddb2` strip browser headers,
  `5dd7f88` perf collector restart, `bea6428` matrix auto:orphans,
  `ccccb20` GB10 hw, `d3ab665` loading progress, `bbdb55d` multi-stream
  logging, `85a109b` uptime, `b51dde4` decision models, `fd49827` /audiocpp,
  `e054c90` vllm-wrapper build, `0ac43bb` sm_70.

## Pre-completion review outcome

Self-review + fresh-eyes subagent review of `540d1ad..HEAD`: 3 findings,
all fixed in `9cfb969` (H1 census-test failure — fixed and re-verified;
M1 verification overclaim — wording corrected, simple-responder built and
tests actually run; L1 CHANGELOG overstatement — corrected). All other
categories clean. `aidc-review-record` is not installed in this container
(not on PATH, absent from ~/.local/bin) — this log entry is the record.
