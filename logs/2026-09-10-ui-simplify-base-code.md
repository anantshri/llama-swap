# 2026-09-10 — ui: reduce/simplify the vanilla JS/CSS base (zero functional change)

## Symptom

Not a bug — a size problem. The hand-authored UI under
`internal/server/ui_dist/` (no build step, committed directly) had grown
per-interface copies of the same logic: task lifecycle, spinner/error
markup, escaping, downloads, fetch wrappers, conversation persistence,
and three near-identical SSE reader loops.

Request: reduce/simplify the HTML/JS/CSS to fewer lines with **not a
single functionality changed or reduced** — structural simplification,
not minification.

## Diagnosis

Four /simplify review angles (reuse, simplification, efficiency,
altitude) over the UI surfaced ~7 risk-ordered batches. The recurring
patterns and their owners:

| Pattern | Instances | Shared home |
| --- | --- | --- |
| activity flag + AbortController + AbortError swallow | audio, speech, image, rerank | `playgroundActivity.runTask` |
| spinner / error stage markup | 5 interfaces | `dom.pgSpinner` / `dom.pgError` |
| `escapeAttr`/`escapeText` locals | image, modelSelector (pre-existing) | `dom.escapeHtml` |
| `<a download>` click | chatMessage, image | `dom.triggerDownload` |
| pg-no-models class toggle | 5 interfaces | `api.subscribeHasModels(root, onEmpty?)` |
| REST ok-check + error labels | api/* wrappers, api.js | `api.fetchOk` / `apiFetch` / `postJSON` |
| throttled localStorage save | chat, docs | `store.throttledSaver` |
| messages load + sanitize | chat, docs | `store.loadStoredMessages` |
| scroll-to-bottom w/ user-override | chat, docs | `dom.stickToBottom` |
| reader/decode/split SSE loop | 3 chat parsers | `api/chat.readChunks` |
| statusDotClass / modelServerPath | modelsPanel, modelDetail | `util/modelUtils.js` |

## Change

30 files, +539 / −766 (net −227). Highlights (full detail in
DETAILED_CHANGELOG.md):

- audio 214→205, speech 287→256, image 454→413, rerank 360→345,
  chat 501→461, docs 561→531, api/chat 334→307, api/* 74→40.
- Behavior-preservation decisions: `getCapture` left hand-rolled (404
  returns null WITHOUT logging); docs saver unified on chat's
  clearTimeout variant (docs previously stacked timers — final persisted
  state identical); chat-completions trailing-buffer asymmetry preserved
  via `flushLast` (leftover `[DONE]` tail swallowed, non-done tail
  yielded); copy sites with differing fallback semantics NOT migrated to
  `copyText` (only chatMessage's).
- app.css: unused `.activity-columns-wrap/-btn-wrap/-btn`,
  `.page-playground`, dup `.icon-5`, no-op prompt-row media removed. The
  "duplicate" `@media(min-width:768px){.pg-tab-mobile{display:none}}` is
  load-bearing (base `display:block` sits between the two media blocks)
  — kept and documented.
- Drive-by fix of a pre-existing crash: imageInterface line 122 called
  `escapeHtml` unimported → opening SDAPI Settings threw ReferenceError
  and left the panel blank (present at HEAD). Import added.

## Commands

```sh
# parse gate (container has no JS runtime; bun installed to ~/.bun)
for f in $(find js -name "*.js" ! -name "*.map"); do
  ~/.bun/bin/bun build --no:bundle "$f" >/dev/null || echo "FAIL $f"; done

# golden-output harnesses (baselines captured pre-refactor)
cd /tmp/ui-smoke && ~/.bun/bin/bun smoke.mjs      > now.json    # DOM-free modules
~/.bun/bin/bun md-smoke.mjs   > md-now.json  # markdown.js
~/.bun/bin/bun chat-smoke.mjs /tmp/ui-smoke/chat-now.json  # 3 stream parsers
diff baseline.json now.json && diff md-baseline.json md-now.json && diff chat-baseline.json chat-now.json

go test ./internal/server/   # ui embed tests
make test-all                # full suite incl. concurrency
make gosec                   # 0 findings
aidc-scan                    # clean
```

## Verification

- All 58 JS files parse; three harnesses byte-identical to baselines.
- chat-smoke.mjs (new this session): 16 scenarios — mid-line splits,
  done mid-stream vs done-in-tail, malformed JSON/events, event-only
  blocks, tail blocks without final newline — for all three endpoints.
- `make test-all` ok, `make gosec` 0, `aidc-scan` clean.

## Notes

- Mid-session incident worth remembering: `Write` to
  `js/util/modelUtils.js` silently replaced the existing tracked file
  (it only held `groupModels`, imported by modelSelector) with the new
  statusDotClass/modelServerPath content — 8 files stopped parsing until
  `groupModels` was restored alongside. Parse-check the whole tree, not
  just edited files.
- Two Edit mishaps (wrong CSS line replaced; changelog header clobbered)
  were caught by diffing against HEAD / grep-ing entry order — always
  re-inspect multi-file edits before declaring done.
- Verification harnesses live in /tmp (ephemeral); chat-smoke.mjs is
  worth reviving if the parsers are touched again.
