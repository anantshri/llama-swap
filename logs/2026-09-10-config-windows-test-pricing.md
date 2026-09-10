# 2026-09-10 — config: fix TestConfig_LoadWindows after pricing defaults

## Symptom

GitHub Actions Windows runner failed `make test-all`:

```
--- FAIL: TestConfig_LoadWindows (0.02s)
    config_windows_test.go:293:
        Expected: Pricing: (config.PricingConfig) {Currency: "", USDToINR: 0}
        Actual  : Pricing: (config.PricingConfig) {Currency: "USD", USDToINR: 95}
```

Linux runs were green — the failure only appeared on the Windows leg of the
CI matrix.

## Diagnosis

The pricing feature (commit 79ac1a0, "stats shananigans") added
normalization in `PricingConfig.Validate()`
(`internal/config/pricing.go:49`): an unset `currency` becomes `USD` and a
zero `usdToINR` becomes `DefaultUSDToINR` (95). The `!windows` twin test
`TestConfig_LoadPosix` was updated with the normalized `Pricing` block in
its expected `Config` (`config_posix_test.go:291`), but the
`//go:build windows` copy was not — the file only compiles on Windows, so
Linux dev/CI never catches staleness there.

## Change

`internal/config/config_windows_test.go` — added the same expected block to
`TestConfig_LoadWindows`, in the same position as the posix twin (between
`Upstream` and `Routing`):

```diff
 		Upstream: UpstreamConfig{
 			IgnorePaths: DefaultUpstreamIgnorePaths(),
 		},
+		Pricing: PricingConfig{
+			Currency: "USD",
+			USDToINR: DefaultUSDToINR,
+		},
 		Routing: RoutingConfig{
```

Test-only change; no production code touched.

## Commands

- `GOOS=windows go test -c -o /dev/null ./internal/config` — compiles OK
  (the test cannot execute on Linux; compilation is the available check)
- `go test -race -count=1 ./internal/config/` — ok
- `gofmt -l internal/config/` — clean
- `make test-all` — ok, all 21 packages
- `make gosec` — 0 issues (115 files, 24666 lines)
- `aidc-scan` — clean (semgrep, gitleaks, gosec in scope)

## Verification

Windows CI is the only place the test executes. The expected block is
byte-identical to the posix twin's, which passes and asserts the same
normalization path through `Load`, so the Windows run should be green again.

## Notes

- The other Windows-only test files (`internal/hw/hardware_windows_test.go`,
  `internal/perf/d3dkmt_windows_test.go`, `internal/perf/pdh_windows_test.go`)
  do not compare `Config` structs and are unaffected by the pricing defaults.
- Changelogs updated: `CHANGELOG.md` (Fixed), `DETAILED_CHANGELOG.md`.
