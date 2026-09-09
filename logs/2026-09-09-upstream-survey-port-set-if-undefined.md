# 2026-09-09 — Upstream survey + port #1075 (set-if-undefined params)

## Goal

User asked to survey upstream (mostlygeek/llama-swap) for features worth
porting to this fork.

## Survey findings

`git fetch upstream` then `git log 7a14664..upstream/main` → 12 commits.
Triage against fork reality (fork has no tailcat subsystem, no docker
workflows, vanilla-JS UI instead of Svelte, and its own unmerged-upstream
`SetParamsByMatch`):

- **Ported now: #1075** set-if-undefined `?` key suffix (user's pick).
- Skipped: #1074/#1091/#1098 tailcat (whole subsystem absent, heavy deps),
  #1093 CUDA13 docker (workflows removed here), #1088 help-agent tuning.
- Deferred by user choice: #1104 tabbyAPI metrics (tiny, good candidate),
  #1099 live chat stats (large vanilla-JS project), #1089 max_tokens bump,
  #1087 jq get_config (needs gojq dep), #1101 Work-bar polish.

## Change (the #1075 port)

Hand-merged, not cherry-picked — upstream's filters.go lacks the fork's
SetParamsByMatch:

- `internal/config/filters.go`: shared `sanitizeParams()` returning
  `(params, keys, soft)`; `?` suffix stripped and reported; hard spelling
  wins; `model?` still protected; bare `?` ignored; soft nil when empty.
- `internal/server/filters.go`: `applyFilters` skips soft keys whose path
  exists in the body at that stage; pipeline is
  `strip | byMatch | setParams | byID` so earlier-stage values count as
  defined and stripped keys as undefined.
- Schema/example-config/KB docs updated; new KB article
  `set-if-undefined.md`; fixed the fork KB's order-of-operations list that
  was missing its own setParamsByMatch step.
- Tests ported from upstream's additions for both config and server layers.

## Commands

- `go test ./internal/config/ ./internal/server/ -run "Filters|Filter"` → ok
- `make test-dev` → ok; `make gosec` → 0; `aidc-scan` → clean
- E2E with fake responder: request with `max_tokens: 100` kept it; request
  without gained `max_tokens?: 4096` → `4096`; `temperature` forced in both.

## Verification notes

aidc-scan surfaced 2 historical gitleaks findings (placeholder
`nodekey:012345…` in tailcat docs — fork's removed experiment + upstream
ref). Working tree clean (rg), `trufflehog filesystem` → 0 secrets.
Fingerprints added to `.gitleaksignore` per its ledger convention; scan now
clean.

## Notes / follow-ups

- Good next ports if wanted: #1104 (tabbyAPI usage extraction — tiny,
  improves stats accuracy), #1089 (docs-agent max_tokens bump — trivial).
- #1099 (live generation stats in chat) is the biggest UX win upstream has
  but needs a real vanilla-JS implementation plan.
