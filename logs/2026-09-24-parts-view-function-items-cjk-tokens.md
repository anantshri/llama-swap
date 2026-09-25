# 2026-09-24 — Parts view follow-ups (PR #25 review M1 + L2)

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
