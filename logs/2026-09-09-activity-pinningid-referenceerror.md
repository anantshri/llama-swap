# 2026-09-09 — Activity page not populating (`pinningId` ReferenceError)

## Symptom

`#/activity` rendered no request rows and capture details could not be opened.
Browser console, once per refresh:

```
activityTable.js:447 Failed to refresh activity: ReferenceError: pinningId is not defined
    at cellHtml (activityTable.js:118:20)
    at activityTable.js:329:83
    at renderBody (activityTable.js:329:29)
    at refresh (activityTable.js:443:7)
```

## Diagnosis

Commit 8b143d3 (2026-09-06, pin Activity captures) added the Capture-column
pin buttons and made `cellHtml` read `const busy = pinningId === m.id;`.
`cellHtml` is a module-scope helper, but `pinningId` is a local of the
`ActivityTable()` closure (declared alongside `loadingCaptureId` and used by
the row click handler). The reference was out of scope, so rendering any row
with `has_capture || pinned` threw a `ReferenceError` inside `renderBody`.
`refresh()`'s `try/catch` swallowed it (logging "Failed to refresh activity")
after `rows` had been assigned, so the table body stayed empty. Rows without a
capture hit the early `return` before the bad line, which is why the page only
broke once at least one capture existed.

## Change

`internal/server/ui_dist/js/components/activityTable.js`:

```diff
-function cellHtml(m, key, loadingCaptureId) {
+function cellHtml(m, key, loadingCaptureId, pinningId) {
```

```diff
-    bodyEl.innerHTML = rows.map((m) => `<tr class="activity-tr">${cols.map((c) => cellHtml(m, c.key, loadingCaptureId)).join("")}</tr>`).join("");
+    bodyEl.innerHTML = rows.map((m) => `<tr class="activity-tr">${cols.map((c) => cellHtml(m, c.key, loadingCaptureId, pinningId)).join("")}</tr>`).join("");
```

Same pattern the function already used for `loadingCaptureId`. The click
handler continues to read/write the closure variable; the busy/disabled state
now flows into the render through the parameter.

## Commands

- `go test ./internal/server/ -run 'TestUI|TestServe' -count=1` → ok
- `~/.bun/bin/bun build --no-bundle internal/server/ui_dist/js/components/activityTable.js` → parses
  (the `bun` on PATH is a broken pmg shim; invoke `~/.bun/bin/bun` directly)
- `aidc-scan` → semgrep + gitleaks clean

## Verification

- `bun build --no-bundle` parses the modified module.
- `rg 'pinningId'` in the file: declaration (closure), new parameter, call
  site, click handler — all references now resolve.
- Manual: load `#/activity` with ≥ 1 capture → rows populate, View opens the
  capture dialog, pin/unpin buttons disable while their request is in flight.

## Notes

Regression introduced by 8b143d3. Lesson: `cellHtml`/`inflightCellHtml` are
module-scope — anything they render must arrive as a parameter, closure
locals are invisible to them.
