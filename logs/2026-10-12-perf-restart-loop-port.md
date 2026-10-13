# 2026-10-12 — Perf GPU-collector restart loop port (5dd7f88)

## Goal

First of the hand-merge batch, per user decision: take upstream's fix for
the one conflicting hunk (their error-logging `cmd.Wait()` over our G104
discard `_ = cmd.Wait()`).

## Change

- `git cherry-pick 5dd7f88` → single conflict in
  `internal/perf/monitor_unix.go`; resolved to upstream's variant:
  `if err := cmd.Wait(); err != nil && ctx.Err() == nil { logger.Errorf(...) }`.
  G104-clean (error is checked); collector exits now logged.
- monitor.go restart loop (+119) and monitor_test.go (+266) applied clean.

## Symptom → diagnosis (test stability)

New tests flaked under the full suite, then failed deterministically in
multi-test contexts (perf+process, `-p 1`, `-count=5`). Timeline of
diagnosis: deadline bumps (2s→5s→15s) made it *worse* → events never
arrive, not slow → `-count=5` verbose showed iteration 2 passing in 0.00s
→ cross-iteration impossible (all state per-test) → root cause inside one
iteration: `fakeGpuCollector.wait` returned **instantly**, so six fake
collectors cycled in microseconds while the test goroutine was still
entering its drain loop; the monitor's publish is non-blocking
(`select`+`default`, buffer 1), so the one stat the test waited for
(collector 6) could be dropped. Upstream test race; our parallel-suite
timing just exposed it.

## Fix

- `fakeGpuCollector.wait` → `waitOrDone(ctx, time.Millisecond)` (paces the
  loop; aborts on ctx; wait history unchanged).
- New tests' wait deadlines: 10s headroom (was upstream 2s), comments point
  at the pacing fix as the actual cure.

## Commands

```
git cherry-pick 5dd7f88        # resolve monitor_unix.go to theirs
go test ./internal/perf/ -count=1                      # 68 ok
go test -run TestStart_GpuRestartWaitResetsAfterStats ./internal/perf/ -count=10  # 10/10
go test -short ./...                                    # x3, 1901/32 ok
GOOS={linux,darwin,windows} gosec -quiet ./...          # 0
aidc-scan                                               # clean
```

## Verification

- 3× consecutive full short suite green (1901 tests / 32 packages).
- Previously-failing combos (perf+process parallel and `-p 1`, the
  Doubles+Reset pair, `-count=5`) all green.
- gosec 0 ×3; aidc-scan clean; gofmt clean.

## Notes

- Fresh-eyes review: 2 Low findings — doubled `---` in DETAILED_CHANGELOG
  (fixed); pacing-by-1ms is a heuristic, not synchronization (documented
  here; if it ever reflakes, make the fake's delivery acknowledged instead
  of paced). Everything else verified clean: upstream hunk byte-identical,
  no dropped hunks, no sysfs/Stop interactions, gosec 0 ×3.
- `nproc` is 16 here; the flake was NOT CPU starvation (failed with `-p 1`
  too) — worth remembering when a "flaky under load" test resists deadline
  bumps: look for drop-on-full publish + instant fakes.
- Next in the hand-merge queue: `486376e` content-type middleware,
  `b51dde4` decision models, `d34ddb2` browser headers (trim test),
  `e054c90` (drop kubeswap), then `bea6428`, `bbdb55d`, `d3ab665`,
  `0ac43bb`.
