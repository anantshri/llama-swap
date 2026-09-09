# 2026-09-09 — Fold fork PR #19: sortable Stats page table

## Symptom / goal

anantshri/llama-swap#18: "the stats page table should be sortable."
ai-anant opened PR #19 (commit `cc7a865`) fixing it; goal was to fold that PR
into this repo's `stats` branch.

## Diagnosis

PR #19 does **not** apply as a patch here. It was authored against the
pre-rebase `stats.js`, which fetched `/api/metrics/activity?limit=999` and
aggregated client-side into a `Map` of per-model buckets (`promptSpeeds`
arrays, `toRow()`/`compareRows()` over those buckets). This fork's Stats page
was since moved to server-side aggregation (`/api/metrics/stats`, snake_case
per-model rows: `requests`, `input_tokens`, `output_tokens`, `cached_tokens`,
`avg_prompt_speed`, `avg_gen_speed`, `total_duration_ms`, `last_used`), so the
PR's aggregation half is obsolete. The *feature* half (sortable headers,
`data-sort` + ▲/▼ indicators, asc/desc toggle, requests-descending default)
was folded in and re-targeted at the server-aggregated rows.

Environment note: no JS engine was present; the `bun` on PATH was a broken
pmg shim (`pmg setup install` fixed the shim, but the actual bun runtime was
missing). Installed real bun via `curl -fsSL https://bun.sh/install | bash`
— needed only for a syntax check, the UI has no build step.

## Change

- `internal/server/ui_dist/js/pages/stats.js`
  - Headers: `stats-th-sortable` class + `data-sort` keys (`model`,
    `requests`, `inputTokens`, `outputTokens`, `cachedTokens`,
    `avgPromptSpeed`, `avgGenSpeed`, `avgDuration`, `lastTimestamp`) +
    `.stats-sort-ind` span, mirroring `activityTable.js`.
  - `sortKey`/`sortOrder` state, default `requests`/`desc`.
  - `sortValue(s)`: maps camelCase sort keys → snake_case server fields;
    `null` speeds → `-1` (render as "—", sort last on desc), `last_used`
    → `0` when missing, `avgDuration` = `total_duration_ms / requests`.
  - `compareRows`: direction multiplier + model-name tie-break (from PR).
  - `renderSortIndicator()`: ▲/▼ + `.active` on the current column.
  - `renderTable` sorts `[...stats.models]` (copy — server array untouched)
    and an `thead` click handler toggles direction on re-click / switches to
    desc on new column, then re-renders. Default order unchanged.
- `internal/server/ui_dist/css/app.css`: `.stats-th-sortable`
  (cursor + hover color), `.stats-sort-ind(.active)` (opacity 0.35 → 1) —
  same values as the activity equivalents in `newpages.css`.

## Commands

- `pmg setup install` (repair shims)
- `curl -fsSL https://bun.sh/install | bash`
- `bun build --no-bundle internal/server/ui_dist/js/pages/stats.js` → OK
- `go test ./internal/server/` → ok
- `make test-dev` → all packages ok (staticcheck binary absent; no Go changes)
- `aidc-scan` → semgrep + gitleaks clean

## Verification

Syntax parse of the module (PR used `node --check`; bun equivalent here),
embedded-UI serving tests via `go test ./internal/server/`, and manual
behavior: click cycles desc → asc on the same column, moves column on new
click, indicator follows, empty state unaffected.

## Notes

- PR: https://github.com/anantshri/llama-swap/pull/19 ·
  Issue: https://github.com/anantshri/llama-swap/issues/18
- `loading` flag in `stats.js` is pre-existing dead-ish state; left alone.
