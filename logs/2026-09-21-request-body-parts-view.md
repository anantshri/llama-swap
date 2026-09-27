# 2026-09-21 — Activity capture dialog: request-body parts view (issue #24)

## Symptom / goal

Issue [#24](https://github.com/anantshri/llama-swap/issues/24), "Activity View
enhacement": *"If a request contains multiple parts, we should also show them
seperately — system prompt, user prompt, tool calls. if possible word count +
token count for each of them would also help."*

The Activity page could already open a request/response capture, but the Request
Body section showed only `Pretty` and `Raw` JSON, so a tool-using conversation
had to be read as a single blob with no sense of how the prompt split between
the system prompt, each message and the schemas.

## Diagnosis

`internal/server/ui_dist/js/components/captureDialog.js` built the Request Body
section from two tabs (`pretty` from `formatJson`, `raw` from the decoded body).
Nothing inspected the request JSON structurally, so the roles never surfaced.

Request bodies that reach a capture are OpenAI-shaped on every path: the
`/v1/messages` Anthropic handler translates the request
(`apiconv.AnthropicToOpenAIRequest`) *before* `dispatchTranslated` runs the
metrics middleware that stores the capture
(`internal/server/server.go:322-340`, `internal/server/anthropic.go:33-77`), so
the dialog only has to understand `messages[]`, top-level `system`/`instructions`
(Anthropic passthrough also lands here untranslated), `tools`/`functions`,
`prompt` (completions) and `input` (responses).

There is no tokenizer anywhere in the tree — `grep -rn 'tokenize' internal/` only
finds the doc-agent search tokenizer and the matrix DSL. The only token numbers
llama-swap sees are the upstream `usage` totals parsed in
`internal/server/metrics.go:extractUsageTokens`; those are per request, not per
message, and are not part of the capture payload (`internal/server/captures.go`).
Per-part token counts therefore have to be estimated client-side.

## Change

UI files are hand-authored ES modules committed to the repo with no build step
(`AGENTS.md`), so the served files were edited directly:

- `internal/server/ui_dist/js/components/captureDialog.js`
  - `countWords()` — splits on runs of whitespace.
  - `estimateTokens()` — `max(1, round(chars / 4))`; every display site labels it
    `≈`.
  - `contentText()` — flattens string / typed content-part arrays
    (`text`, `input_text`, `image_url`, `image`, `input_audio`, `tool_use`,
    `tool_result`) / arbitrary objects into display text.
  - `prettyArgs()` — JSON-decodes and re-indents tool-call arguments, which
    arrive as a JSON *string*.
  - `splitRequestParts(body)` → `{parts, totals}`: top-level `system` and
    `instructions`; one part per `messages[]`/`input[]` item labelled by role
    (`messages[2] · tool · result for call_1`); one part per `tool_calls` /
    legacy `function_call`; one part for `tools`/`functions`; `prompt`/`input`
    strings. Returns `null` when the body has none of these.
  - `requestPartsHTML()` / `requestPartsText()` — the view (per-part `<details>`
    with a stats line, plus a totals line) and the plain-text form the Copy
    button uses. All text goes through `escapeHtml`.
  - `requestPartsFor()` — memoizes the parse of the current body string so tab
    switches do not re-parse large prompts.
  - Tab row becomes `Parts | Pretty | Raw`; `defaultReqTab()` lands multi-part
    requests on `Parts`, single-part and non-JSON bodies keep the previous
    behaviour; a stale `parts` tab falls back to `pretty`.
- `internal/server/ui_dist/css/app.css` — `.capture-parts*` / `.capture-part*`
  styles with role colours.
- `internal/server/ui_dist/__selftest.html` — new groups covering the helpers,
  the request shapes, totals, the `null` case and HTML escaping.

## Commands

```
make test                       # go test -short -count=1 ./internal/...
gofmt -l .                      # no output
go vet ./internal/server/       # clean
python3 ../verify24_parts_view.py
```

## Verification

- Self-test harness in headless Chromium (`verify24_parts_view.py`, Playwright
  against `ui_dist` served over HTTP): **107/107 passed — all green**
  (20 of those tests are new).
- Same session drove `CaptureDialogController.open()` with a synthetic capture
  (system prompt + user + assistant `tool_calls` + tool result + assistant with
  an image content part + one tool schema):
  - tabs `['Parts', 'Pretty', 'Raw']`, active tab `Parts`
  - totals `6 parts · 189 chars · 30 words · ≈49 tokens`
  - parts: `system (top-level)`, `messages[0] · user`,
    `messages[1] · tool_call add`, `messages[2] · tool · result for call_1`,
    `messages[3] · assistant`, `tools (1)`, each with its own counts
  - Raw still renders a plain `<pre>`; Parts survives the round-trip
  - a single-message body still opens on `Pretty`
  - no page errors
- `make test` passes with the changed assets embedded; no Go code changed, so
  `make gosec` is unaffected.

## Notes

- Why an estimate rather than exact counts: exact per-part tokens need either a
  llama.cpp `/tokenize` round-trip per part behind a new server endpoint or a
  bundled tokenizer in the UI — a design decision and a much larger change than
  the issue asks for. The estimate is labelled `≈` with the formula in the
  totals line, and the follow-up is recorded in `DETAILED_CHANGELOG.md`.
- Error hit during verification: the first `__selftest.html` run failed with
  `Unexpected identifier 'raw'` — a literal `</script>` inside a test string
  closed the inline module early. The test now concatenates the tags
  (`"<scr" + "ipt>"`), which is why the escaping test reads the way it does.
- Two of the new tests were wrong on first write (a matcher that does not exist
  in the in-browser harness, and an expectation that forgot a part is skipped
  when its text is empty); both were corrected against real runs rather than
  loosened.
