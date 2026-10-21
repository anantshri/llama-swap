# 2026-10-13 — Tailcat subsystem port

## Goal

User decision: pull in tailcat, the last intentionally-skipped subsystem.

## Approach

Series is entirely post-baseline (8a06d56 → a27436b), so the final
upstream state was snapshotted instead of replaying five commits:
subsystem files copied, shared files hand-merged (llama-swap.go listener
lifecycle, server.go surface, apigroup/api/metrics/redact/load hooks),
peer.go+test taken wholesale after verifying no fork-specific content,
store SrcPrefix filter + index ported to this fork's API (migration
00005), gosec hardening (ledger 93→94, G304 ×11), vanilla /tailcat page +
util + nav, schema/example/KB docs.

## Verification

- Suite green (26 pkgs incl. internal/tailcat transport tests); server
  policy tests 22; selftest 170/170; gosec 0 ×3; aidc-scan --all clean.
- Browser: /api/tailcat answers disabled status; page shows the
  not-enabled notice; no page errors.
- NOT live-verified: -listen-tailcat boot needs the tailcat CLI + relay
  reachability (absent here). First deployment must smoke: boot with a
  generated key, connect a client, confirm tc: activity rows.

## Notes

- upstream go.mod hunks for tailcat carry gin/etc via tidy — deps grew
  (tailscale.com + gvisor); `go mod tidy` is the source of truth.
- The store test lives at internal/store/tailcat_src_test.go (adapted
  from upstream's sqlite package; our store is single-package).
- api_test.go in internal/server was upstream's; check TestProxy_
  ConfiguredVoicesOverrideUpstream etc. still pass — they do (564 server
  tests green).
- gitleaks stays clean with the placeholder nodekey in the example.
