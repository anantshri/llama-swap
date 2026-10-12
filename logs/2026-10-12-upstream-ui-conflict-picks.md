# 2026-10-12 — UI-conflict-only upstream picks (GB10, uptime, /audiocpp)

## Goal

User: for the upstream commits whose only conflicts are the deleted Svelte
UI, resolve by `git rm`-ing those files and port the appropriate changes to
the vanilla UI. Batch: `ccccb20` (GB10 hw), `85a109b` (uptime #1173),
`fd49827` (/audiocpp #1223).

## Diagnosis

Upstream has no `internal/server/ui_dist`; the merge rename-detects our
ported vanilla files (`format.js`, `modelUtils.js`) as the Svelte originals
and marks them UU/UA, while genuinely-missing `ui/src/**` files come up
DU/A. So conflicts ≠ Go conflicts: the Go side of all three applied clean.

## Change

- `e2f4e43` = ccccb20 #1163: Go only; `git rm ui/src/{types,Hardware}`.
  Vanilla Hardware page is data-driven — nothing to port.
- `3351168` = 85a109b #1173: kept our `format.js` (`checkout --ours`), rm'd
  Svelte + the rename-placed `middleTruncate.ts` files. Follow-up
  `b3da3a3`: vanilla uptime port —
  - `formatUptime(ms)` in util/format.js,
  - models State cell: `<span data-uptime-base/-at>` rendered from SSE
    `uptimeMs`, a panel-level 1s `setInterval` updates cells in place
    (cleared in `destroy()`), title carries `readySince`,
  - modelDetail Details tab: Uptime + local ready-since row,
  - `.model-uptime` / `.model-detail-row` CSS.
  - Skipped as Svelte-shell specifics: sidebar resize, middle-truncate
    component (different table design).
- `c3f4323` = fd49827 #1223: server/Go + docs applied; README conflict
  resolved onto the fork notice (+ pointer that adopted post-baseline
  features are in the CHANGELOG); `audiocpp_auto` → `/audiocpp/` added to
  both vanilla `modelServerPath` copies (modelsPanel, modelDetail).
- gosec G710 on audiocpp.go redirect — same FP category as comfyui.go:
  line-level `#nosec` + ledger 92 → 93 (G710 ×3).
- Selftest +5: formatUptime scales, uptime cell attrs/non-ready/merge
  survival, audiocpp link href.

## Commands

```
git cherry-pick <sha>            # per commit
git rm -r ui/src                 # Svelte side
git checkout --ours <rename-matched vanilla file>
go build ./... && go test -short ./...        # 1892 tests, 32 pkgs
GOOS={linux,darwin,windows} gosec -quiet ./...
python3 -m pip install --break-system-packages playwright
python3 -m playwright install chromium       # + apt libs per 2026-09-26 log
go build -o build/llama-swap . && <restart server>
python3 /tmp/opencode/run_selftest.py        # 151/151
```

## Verification

- Full short suite 1892/32 ok; gosec 0 ×3; aidc-scan clean.
- Browser selftest 151/151 (rebuilt binary; see gotcha below).
- `/audiocpp/` → 404 without the model configured (expected passthrough
  guard), `/health` 200.

## Notes / gotchas

- **Stale server hid new selftests**: `fuser -k 8765/tcp` via the rtk
  wrapper did NOT kill the old process; the new binary failed to bind and
  the old one kept serving (selftest showed 150 not 151). Fix: `ps aux |
  grep llama-swap` → `kill <pid>` → restart. Always assert the served page
  contains the new test group before trusting a green run.
- Mid-batch the opik edits turned out already committed by another session
  (`a24d78f "opik integration checks"`) — stash reported "No local changes
  to save"; reflog confirmed. Nothing lost.
- The audiocpp pick initially swallowed the uncommitted uptime UI port into
  its commit; split back apart via soft-reset + stash-by-path + re-edit of
  the two-line overlaps (final: `b3da3a3` uptime port, `c3f4323` audiocpp).
- node is absent in this container now; module syntax is verified by the
  browser selftest run instead (a module load failure fails the whole page).

## Pre-completion review outcome

Self-review + fresh-eyes subagent review of `a24d78f..HEAD`: 4 real findings,
all fixed and re-verified in the follow-up commit:

- **H1** Hardware page is field-list driven, not data-driven — GB10's Device
  row and nominal-SoC power fallback were silently dropped; ported
  (`systemLabel`/`powerLabel`) and docs corrected.
- **M2** #1173's interrupted/cancelled-turn chat semantics were neither
  ported nor documented; ported (Cancelled label + Retry title +
  `interrupted` flags; docs-agent variant documented as skipped).
- **M3** uptime re-anchored at every render, resetting the displayed age on
  unrelated re-renders; now anchored per uptimeMs value (selftest covers
  persistence + re-anchoring).
- **L** G204 ledger section header stale (7 vs 8 internal sites; cmd/vllm
  wrapper markers outside audit scope noted). The audit-enforced summary
  line was already correct.

Final gates: `go test -short ./...` 1892/32 ok; gosec 0 ×3 GOOS; aidc-scan
clean; browser selftest **152/152** (verified the served page contains the
new groups before trusting the count). `aidc-review-record` is not installed
in this container — this log entry is the record.

## Remaining upstream batch (real hand merges)

`a2bf16e` gopsutil panic fix · `486376e` content-type autofill · `d34ddb2`
browser headers (one test hunk) · `5dd7f88` perf restart · `bea6428` matrix
auto:orphans · `b51dde4` decision models · `d3ab665` loading progress ·
`bbdb55d` multi-stream logging · `e054c90` vllm-wrapper · `0ac43bb` sm_70.
