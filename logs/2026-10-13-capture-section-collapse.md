# 2026-10-13 — Capture dialog: sections keep collapse state

## Symptom

User report: in the Activity capture view, clicking the response's
Chat/Pretty/Raw tabs expanded the collapsed Request sections.

## Diagnosis

Every tab click / Copy click / parts collapse-all calls render(), which
rebuilds the dialog from a template with hardcoded `<details open>` —
manual collapses were wiped on each re-render.

## Change

captureDialog.js: `data-section` names on the four sections;
`sectionAttr()` renders `open` unless state.sectionOpen[name] === false;
`toggle` listeners record state; `open()` resets the map per capture.

## Verification

- Selftest 168/168 (+1). Gotchas hit: `await` in a non-async test callback
  is a module-level SyntaxError (page stuck on "Running…" — check
  pageerror); the `toggle` event is a queued task, so the test awaits it
  (setTimeout 10ms) before triggering the re-render — a collapse+render in
  one tick would race, unreachable for real users.
- Playwright E2E (live server, real capture): Request Body collapsed stays
  collapsed across response Raw → Pretty → Chat clicks; no page errors.
- Suite 1991/32 ok; aidc-scan --all clean.

## Notes

- Playwright selector gotcha: `[data-tab='raw']` matches both sections'
  tabs — scope to `details[data-section="respBody"] [data-tab=...]`.
