# 2026-10-12 — Hand-merge batch 2 (vllm-wrapper, sm_70, auto:orphans)

## Goal

User approved: e054c90 (drop kubeswap), 0ac43bb (adopt upstream
build-image.sh wholesale), bea6428 (auto:orphans semantic merge).

## Change

- `c2c5106` = e054c90 #1156: lib-release.sh + installers clean; dropped the
  kubeswap build stage from runtime.Dockerfile.
- `2575683` = 0ac43bb #1187: build-image.sh taken wholesale (supersedes our
  drifted copy — two-image CUDA12/13, per-platform arch tables, V100 sm_70
  in the CUDA 12 image); README GPU section from upstream; verified no
  kubeswap references remain in docker/unified.
- `6e5df33` = bea6428 #1026 auto:orphans:
  - Diagnosis: our #1026 port (`+undefined`, inline nodeOr, undefinedMode)
    and upstream's bea6428 (`auto:orphans`, buildModelSet, orphanMode) are
    the same feature at different vintages → adopt upstream wholesale.
  - Verified program.go had no fork-specific content beyond the old
    implementation before `checkout --theirs`.
  - router/matrix.go hand-merge: upstream's uses `logmon.Group`
    (#1172-era API, not ported yet) — kept our wiring, adopted their
    messages/names via `matrix.OrphanSetName`.
  - Schema/KB from upstream minus the kubeswap Helm paragraph.
  - Deleted superseded matrix_undefined_test.go + program_undefined_test.go
    (upstream's *_orphans_test.go cover the same cases + more).
  - BREAKING: `+undefined` configs must rename to `+auto:orphans`.

## Security cleanup

aidc-scan --all (first whole-repo run in a while) surfaced 10 semgrep
findings: 3 new from our #1213 wol-proxy port (2 fprintf-to-responsewriter
on constant HTML writes, 1 django-no-csrf-token misfire on the static
consent form), 6 pre-existing capcompat httptest fixture writes, 1
pre-existing agentTools unsafe-formatstring. All suppressed inline with
reasons (exact rule id + finding's start line matters — guessed ids and
off-line markers do not suppress); ledger updated. Whole-repo semgrep now 0.

## Commands

```
git cherry-pick e054c90 / 0ac43bb / bea6428   # resolutions per above
go test -short ./...                          # 1942/32 ok
GOOS={linux,darwin,windows} gosec -quiet ./... # 0
aidc-scan ; aidc-scan --all                   # clean / clean
bash -n + shellcheck -x docker/unified/*.sh   # clean
python3 -c json.load(config-schema.json)      # valid
```

## Verification

- Full short suite 1942/32 ok ×2 (one earlier "0 passed, 1 failed" was a
  wrapper-parse transient; immediate rerun green, build clean).
- gosec 0 ×3; semgrep 0 repo-wide; gitleaks/shellcheck clean.

## Notes

- The two remaining big queue items (bbdb55d logging, d3ab665 loading
  progress) still need their dedicated sessions; d34ddb2's trimmed #1172
  test assertions return with bbdb55d; router/matrix.go will want
  upstream's logmon.Group wiring when #1172 lands.
- `+undefined` → `+auto:orphans` is the only breaking change of the night.
