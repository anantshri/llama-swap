# semgrep suppressions (false positives)

`aidc-scan` runs `semgrep scan --config auto` and treats WARNING/ERROR findings
as gate failures. Every finding in first-party code has been reviewed; the one
real issue (a GitHub Actions shell-injection in `release.yml`) was **fixed** by
passing the untrusted input through `env`. The rest are false positives or
by-design and are suppressed inline with a documented
`// nosemgrep: <rule-id>` (or `# nosemgrep:` in YAML) marker.

Vendored, third-party minified UI libraries under
`internal/server/ui_dist/vendor/` are excluded from directory scans via
`.semgrepignore`. Because `aidc-scan` passes changed files to semgrep
explicitly (which bypasses `.semgrepignore`), the individual findings inside
those bundles (Chart.js, highlight.js, KaTeX — prototype-pollution,
non-literal-regexp, incomplete-sanitization) also carry a per-line
`// nosemgrep:` guard. These are pre-built third-party libraries, not
first-party code, and are validated to still parse (`node --check`).

To list the live markers:

```sh
grep -rn "nosemgrep" internal/ cmd/ .github/
```

(ui_dist markers are included by the `internal/` prefix above.)
## Rule categories suppressed

- **`no-fprintf-to-responsewriter`, `no-direct-write-to-responsewriter`,
  `no-printf-in-responsewriter`** — the XSS-audit rules assume an HTML response.
  llama-swap is a JSON / plain-text / Prometheus / SSE API and proxy; it never
  emits HTML, so writing bytes to the `http.ResponseWriter` is normal and safe.
  Sites: `internal/perf/prometheus.go`, `internal/swaputil/http.go`,
  `internal/server/{api,apigroup,log}.go`, `cmd/{fake-model,wol-proxy}`, tests.
  The wol-proxy confirm/loading pages (#1213) write constant HTML — the two new
  `fmt.Fprint` sites carry inline markers; the remaining live hits are
  `httptest` fixture responders in `internal/capcompat/{capcompat,service}_test.go`
  (static JSON bytes, reviewed FP) and the pre-existing category sites above.
- **`django-no-csrf-token`** — misfire of a Django-template rule on the static,
  Go-embedded `cmd/wol-proxy/confirm.html` consent page; the form's POST is the
  action being confirmed and there is no cookie/session to forge. Inline marker
  on the form.
- **`unsafe-formatstring`** — misfire of a Python-style format-string audit on
  a JavaScript template literal. Site: `internal/server/ui_dist/js/agent/
  agentTools.js` (warning text built from internal tool names). Inline marker
  on the statement.
- **`dangerous-exec-command`** — launching operator-configured model commands is
  the product's core function (also `#nosec G204`). Sites:
  `internal/process/process_command.go`, `cmd/vllm-wrapper`.
- **`open-redirect`** — relative, same-origin redirects with fixed prefixes
  (also `#nosec G710`). Site: `internal/server/api.go`.
- **`math-random-used`** — non-cryptographic load-balancing selection (also
  `#nosec G404`). Site: `internal/router/loading.go`.
- **`racy-append-to-slice`** — the flagged append runs on the main goroutine
  before any concurrent goroutine starts; the concurrent appends are
  mutex-guarded. Site: `internal/server/server.go`.
- **`iterate-over-empty-map`, `string-to-int-signedness-cast`** — Windows GPU
  telemetry syscall code. Site: `internal/perf/pdh_windows.go`.

(The docker-build workflows that carried `run-shell-injection` suppressions were
removed in this fork — images are not built here. The `docker/` build assets
themselves are kept to minimize upstream-merge churn.)
