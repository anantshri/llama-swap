## Project Description:

llama-swap is a light weight, transparent proxy server that provides automatic model swapping to llama.cpp's server.

## Tech stack

- golang
- typescript, vite and svelt5 for UI (located in ui/)

## Workflow Tasks

- when summarizing changes only include details that require further action
- just say "Done." when there is no further action
- use the github CLI `gh` to create pull requests and work with github
- Rules for creating pull requests:
  - keep them short and focused on changes.
  - never include a test plan
  - write the summary using the same style rules as commit message

## Testing

- Follow test naming conventions like `TestServer_<test name>`, `TestProcessCommand_<test name>`, etc.
- Use `go test -v -run <name pattern for new tests>` to run any new tests you've written.
- Run `gofmt -w <file>` before committing to fix any formatting
- Build go binaries into the ./build/ subdirectory
- Use `make test-dev` after running new tests for a quick over all test run. This runs `go test` and `staticcheck`. Fix any static checking errors. Use this only when changes are made to any code under the `internal/` directory
- Use `make test-all` before completing work. This includes long running concurrency tests.
- The web UI under `internal/server/ui_dist/` is hand-authored vanilla ES-module JavaScript committed to the repo with no build step; edit the served files directly. Go's `make test` covers serving/embedding (`internal/server/ui_test.go`).

## Security scanning

- Run `make gosec` after code changes; it scans `GOOS=linux`, `darwin`, and `windows` and must report zero findings.
- Fix genuine findings. For a false positive, suppress at the exact line with `// #nosec G<rule> -- <reason>` — never restructure code to dodge the scanner and never blanket-disable a rule.
- Every suppression is documented in [docs/gosec-suppressions.md](docs/gosec-suppressions.md); update that ledger whenever you add or remove a `#nosec` marker.

### Commit message example format:

```
proxy: add new feature

Add new feature that implements functionality X and Y.

- key change 1
- key change 2
- key change 3

fixes #123
```

## Code Reviews

- use three levels High, Medium, Low severity
- label each discovered issue with a label like H1, M2, L3 respectively
- High severity are must fix issues (security, race conditions, critical bugs)
- Medium severity are recommended improvements (coding style, missing functionality, inconsistencies)
- Low severity are nice to have changes and nits
- Include a suggestion with each discovered item
- Limit your code review to three items with the highest priority first
- Double check your discovered items and recommended remediations

<!-- aidc:core-logics:start -->
# Shared Agent Guidance (aidc)

Read `/opt/CORE_LOGICS/patternlist.md` before starting work.

Use `/opt/CORE_LOGICS` for reusable guidance that should survive beyond this repo. Add broadly useful patterns there on the current project branch rather than storing them only in repo-local scratch files.

Keep project edits inside `/workspace` unless the task explicitly targets `/opt/CORE_LOGICS`.

## Security guardrails (non-negotiable)

Before declaring any code task complete, run the relevant scanners on what you changed and fix every finding above LOW. Do not dismiss findings as "out of scope" or "pre-existing" without explicit user confirmation — fix or flag, never silently skip.

All scanners are pre-installed in the aidc container.

- **Every project**: `semgrep scan --config auto <paths>` on changed files (or the repo for larger changes).
- **Secrets**: `gitleaks detect --no-banner` on the working tree; `trufflehog filesystem --no-update .` if anything looks live.
- **Go** (when `go.mod` present): `gosec ./...`
- **Python** (when `pyproject.toml` / `requirements.txt` / similar): `bandit -r <src>`
- **Rust** (when `Cargo.toml` present): `cargo audit`
- **Ruby** (when `Gemfile` present): `bundle-audit check --update`
- **Node** (when `package.json` present): `npm audit --omit=dev` (or `pnpm audit` / `yarn npm audit`).
- **Dependency vetting** (any language): `vet scan -D .` for SCA against the OSV database.

When findings exist, the work is not done. Fix them, re-run the scan, and only then report the task as complete.
<!-- aidc:core-logics:end -->
