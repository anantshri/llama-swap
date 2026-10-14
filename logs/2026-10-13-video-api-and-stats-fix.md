# 2026-10-13 — Upstream open-PR ports: video API (#991) + stats fix (#1147)

## Goal

User pick from the open-PR survey: check feasibility of #1147 and #991,
pull both if good. Both feasible; both landed.

## Change

- #1147 (8fc8591): model-filtered ActivityStats counts its own rows
  (COUNT(*)) instead of the global MAX(id); prune-test assertion fixed
  to the corrected semantics; interleaved-rows regression test.
- #991: Go (routes incl. DELETE via ?model=, modelInQuery in swaputil,
  video caps, vLLM-omni example) + vanilla Video tab (api/video.js,
  videoInterface.js, playground wiring, CSS, +3 selftests).

## Verification

- E2E with fake vLLM-omni backend: async job lifecycle through the
  browser (poll → completed → playable blob), sync bytes, DELETE, caps
  in /v1/models, picker fit. Fake-backend gotchas: urlencoded query
  breaks naive path endswith checks; age counters need wall-clock.
- Suite green; gosec 0 ×3; aidc-scan --all clean; selftest 173/173.

## Notes

- The failing `TestStore_PruneActivity` assertion (want 5) encoded the
  #1147 bug — fixed to want 2, matching upstream's PR.
- #991 is UNMERGED upstream (open PR); if it merges with changes, re-
  diff then. The PR's Svelte session-headers helper is not part of this
  fork's playground APIs (skipped deliberately).
- Signing one-liner for the user (after committing everything):
  git rebase --exec 'git commit --amend --no-edit -S' 540d1ad
