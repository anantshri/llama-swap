# Add `gosec` to CI and fix existing findings

## Context

The repo currently has formatting (`gofmt`), unit tests (`make test-all`), and an opportunistic `staticcheck` step, but no security-focused static analysis. Running `gosec` (v2.26.1) locally against `./...` surfaces 25 findings spanning real issues (e.g. `http.Server` instances missing `ReadHeaderTimeout`, a true Slowloris exposure) and benign-but-flagged patterns (e.g. `os.Open(operatorConfigPath)` and `exec.Command(...userConfiguredCmd...)` — by design for a process manager). The user wants:

1. A GitHub Action that runs `gosec` on push/PR, blocking on findings.
2. All 25 current findings remediated in-tree so the new workflow is green from day one.

## Scope decision

Scan **all packages** (`./...`) — including `cmd/...` — so the local run and CI are identical. The existing `go-ci.yml` excludes `cmd/**` from its path filter because those are uninstrumented utility binaries; for security scanning we shouldn't be lenient, and the `cmd/` findings are trivial to fix.

## Changes

### 1. New workflow file: `.github/workflows/gosec.yml`

Mirror the conventions in `go-ci.yml`:
- Pinned action SHAs with version comment
- `go-version-file: go.mod` via `actions/setup-go`
- Triggers: push/PR on `main` for `**/*.go`, `go.mod`, `go.sum`, `.github/workflows/gosec.yml`, plus `workflow_dispatch`

Use `go install github.com/securego/gosec/v2/cmd/gosec@v2.26.1` (pinned to match local) rather than the third-party `securego/gosec` action. Keeps the trust model identical to `staticcheck` and avoids a new external action dependency.

Workflow body:

```yaml
- name: Install gosec
  run: go install github.com/securego/gosec/v2/cmd/gosec@v2.26.1
- name: Run gosec
  run: gosec ./...
```

`gosec` exits non-zero on any finding by default, which makes the job fail-fast.

### 2. New Makefile target: `gosec`

Add a `.PHONY` target so contributors can reproduce CI locally:

```makefile
gosec:
	gosec ./...
```

Also add `gosec` to the `.PHONY` line. Document in `AGENTS.md` Testing section that `make gosec` is part of pre-commit verification alongside `gofmt -l .` and `make test-dev`.

### 3. Code fixes — 25 findings

All fixes use idioms already present in the codebase (`_ = …` / `_, _ = …` per `proxy/ollama/buffer.go:118`, `proxy/ollama/stream.go:111`). Where the finding is a true false-positive (operator-supplied input is the product's core function), use `//nolint:gosec // <reason>` rather than restructuring code.

#### G112 — Slowloris (`ReadHeaderTimeout` missing) — 3 findings, real bugs

| File | Line | Fix |
|---|---|---|
| `llama-swap.go` | 117 | Add `ReadHeaderTimeout: 10 * time.Second` to the `&http.Server{…}` literal |
| `cmd/wol-proxy/wol-proxy.go` | 87 | Same |
| `cmd/simple-responder/simple-responder.go` | 316 | Same |

10s matches typical defensive defaults; none of these servers serve large file uploads where a longer header timeout would matter.

#### G115 — `uint64 → int` integer conversion — 5 findings, false positives

All in `internal/perf/monitor_darwin.go` lines 32, 33, 46, 47, 48. Values are system memory totals in **megabytes**, sourced from `gopsutil`. Overflowing `int` on a 64-bit platform requires >9 exabytes of RAM. Fix: append `//nolint:gosec // MB-scale memory counter cannot overflow int on 64-bit` to each conversion line.

#### G404 — `math/rand` weak RNG — 2 findings, false positives

`proxy/process.go:850, 871` pick remark intervals for the loading-message UI feed (`time.Duration(5+rand.Intn(5)) * time.Second`). Not security-sensitive. Fix: `//nolint:gosec // non-security UI message timing` on each line.

#### G204 — Subprocess with tainted input — 2 findings, by design

`proxy/process.go:318` (`exec.CommandContext(...args[0], args[1:]...)`) and `:709` (`exec.Command(stopArgs[0], stopArgs[1:]...)`) execute commands defined in the operator's config — this is the product's core function. Fix: `//nolint:gosec // command supplied by operator config, by design` on each line.

#### G304 — File inclusion via variable — 1 finding, by design

`proxy/config/config.go:184` (`os.Open(path)`) opens the config file at the path the operator supplied on the CLI. Fix: `//nolint:gosec // config path supplied by operator on CLI`.

#### G104 — Unhandled errors — 12 findings, all benign

Use `_ =` / `_, _ =` to explicitly acknowledge. Specifically:

| File | Line | Current | Fix |
|---|---|---|---|
| `proxy/ui_compress.go` | 51 | `origFile.Close()` | `_ = origFile.Close()` |
| `proxy/proxymanager_loghandlers.go` | 61, 86 | `c.Writer.Write(...)` | `_, _ = c.Writer.Write(...)` |
| `proxy/proxymanager.go` | 1029, 1033 | `file.Close()` | `_ = file.Close()` |
| `proxy/metrics_monitor.go` | 286 | `request.Body.Close()` | `_ = request.Body.Close()` |
| `internal/logmon/logging.go` | 214 | `w.Write(...)` | `_, _ = w.Write(...)` |
| `cmd/wol-proxy/wol-proxy.go` | 103 | `server.Close()` | `_ = server.Close()` |
| `cmd/simple-responder/simple-responder.go` | 240 | `c.Writer.Write(...)` | `_, _ = c.Writer.Write(...)` |
| `cmd/misc/process-cmd-test/main.go` | 53 | `cmd.Process.Signal(syscall.SIGTERM)` | `_ = cmd.Process.Signal(syscall.SIGTERM)` |
| `cmd/misc/benchmark-chatcompletion/main.go` | 103, 104 | `io.Copy(...)` / `resp.Body.Close()` | `_, _ = io.Copy(...)` / `_ = resp.Body.Close()` |

## Critical files

- `.github/workflows/gosec.yml` (new)
- `Makefile` (add `gosec` target + `.PHONY`)
- `AGENTS.md` (one-line addition to Testing section)
- `llama-swap.go`, `cmd/wol-proxy/wol-proxy.go`, `cmd/simple-responder/simple-responder.go` — G112 fixes
- `internal/perf/monitor_darwin.go` — G115 nolint comments
- `proxy/process.go` — G404 + G204 nolint comments
- `proxy/config/config.go` — G304 nolint comment
- `proxy/ui_compress.go`, `proxy/proxymanager_loghandlers.go`, `proxy/proxymanager.go`, `proxy/metrics_monitor.go`, `internal/logmon/logging.go` — G104 fixes
- `cmd/wol-proxy/wol-proxy.go`, `cmd/simple-responder/simple-responder.go`, `cmd/misc/process-cmd-test/main.go`, `cmd/misc/benchmark-chatcompletion/main.go` — G104 fixes

## Existing patterns reused

- Error-ignoring idiom `_ = …` / `_, _ = …` — established in `proxy/ollama/buffer.go:118,132`, `proxy/ollama/stream.go:111`, `proxy/proxymanager_api.go:64`
- Workflow scaffold (paths filter, pinned action SHAs, `go-version-file: go.mod`) — copied from `.github/workflows/go-ci.yml`
- Makefile target structure with `.PHONY` line — same as `test-dev`, `test-all`, `test-ui`

## Verification

1. **Local re-run:** `gosec ./...` → expect `Issues : 0`, exit code 0.
2. **Format & build:** `gofmt -l .` returns empty; `go build ./...` succeeds.
3. **Tests still pass:** `make test-all` clean.
4. **CI dry-run:** push to a branch, confirm the new `gosec` job runs and goes green.
5. **Spot-check G112 fixes:** verify each `&http.Server{…}` literal now has `ReadHeaderTimeout` set (`grep -n "ReadHeaderTimeout" llama-swap.go cmd/wol-proxy/wol-proxy.go cmd/simple-responder/simple-responder.go`).
