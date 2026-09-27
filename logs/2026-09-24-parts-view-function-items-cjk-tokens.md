# 2026-09-24 — Parts view follow-ups (PR #25 review M1 + L2) and upstream small-fix ports

## Symptom / goal

Two findings from the code review of PR #25 (request-body parts view):

- **M1**: Responses-API `input[]` items of type `function_call` /
  `function_call_output` were silently dropped from the Parts view — they
  carry neither `role` nor `content`, so the message loop produced no part
  for them.
- **L2**: the token estimate (`chars ÷ 4`) under-counted CJK text ~4x, since
  CJK scripts tokenize at close to one token per character.

## Diagnosis

`internal/server/ui_dist/js/components/captureDialog.js`,
`splitRequestParts()`: the loop only emitted parts from `msg.content` (via
`contentText`) plus chat-shaped `tool_calls` / `function_call`. Responses-API
function items store their payload in `arguments` / `output`, which no branch
read. `estimateTokens()` used a single `len / 4` rate for all scripts.

## Change

- `splitRequestParts()` message loop: two early-return branches before the
  role-based handling —
  - `msg.type === "function_call"` → `tool_call` part from
    `prettyArgs(msg.arguments)`, label `input[i] · function_call <name>`.
  - `msg.type === "function_call_output"` → `tool`-role message part from
    `contentText(msg.output)`, label `input[i] · tool · result for <call_id>`.
- `estimateTokens()`: CJK characters (Han / Hiragana / Katakana / Hangul via
  `\p{Script=...}` regex, iterated by code point) charge 1 token each; the
  remaining characters keep chars ÷ 4. Empty → 0, non-empty → ≥ 1 unchanged.
  Totals note in `requestPartsHTML` updated to
  "≈1 per CJK char, other chars ÷ 4".
- `__selftest.html`: +6 tests (CJK estimates ×2, function-item branches ×4).
- `CHANGELOG.md` parts-view bullet updated; new `DETAILED_CHANGELOG.md` entry.

## Commands

```
make test                                  # go test -short -count=1 ./internal/...
```

## Verification

- No Node/Chromium in this environment (pip venv playwright + chromium
  download timed out; apt nodejs unavailable), so the changed algorithms were
  verified with a faithful Python transliteration of `estimateTokens` /
  `splitRequestParts` against every new self-test assertion — all passed,
  including regressions for the pre-existing request shapes.
- `make test` passes; no Go code changed.

## Notes

- The 6 new in-browser tests await the next headless-Chromium self-test run;
  the algorithm-level check above covers the same assertions.
- Follow-up idea (not implemented): apply the same CJK-aware rate to the
  Stats-page cost estimator if it still uses flat chars ÷ 4.

---

# 2026-09-24 — Upstream small-fix ports (same session)

## Goal

Cherry-pick the five small high-value upstream fixes onto
`updates-25-sep-26`: `8fa8589` (tabbyAPI usage), `0e1f797` (zstd pool),
`21bc145` (TTL from ready), `2edad4a` (forwarded headers), `96e6f94`
(totals after prune).

## Conflicts / adaptations

- `2edad4a`: conflicts in `internal/server/metrics.go`/`metrics_test.go` —
  upstream's base has tailcat and a pre-existing `activitySource()`; the fork
  has neither. Resolved by adding `activitySource()` without the
  `tailcat.SourceFromContext` line. Persistence for the new `Src` field was
  added to the fork's single-file store (`ActivityLogEntry.Src`, INSERT/
  SELECT/sort whitelist) plus goose migration `00003_activity_src.sql`.
- `96e6f94`: upstream-only paths (`internal/store/sqlite/activity.go`) →
  hand-ported `COUNT(*)` → `COALESCE(MAX(id), 0)` into `ActivityStats` and
  extended `TestStore_PruneActivity`.
- The other three picks applied cleanly.

## Commands / verification

```
go test -short -count=1 ./internal/...   # all ok
make test-dev                            # ok; staticcheck: 5 findings, all
                                         # pre-existing on main, none in
                                         # touched files
make gosec                               # 0 issues
aidc-scan                                # gitleaks clean
```

## Notes

- `src` is exposed in the activity API and sortable; Activity-UI display is
  deferred to the upcoming UI-porting round.
- staticcheck was installed during the session (`go install ... staticcheck`);
  `make test-dev` still expects it on PATH for future runs.
