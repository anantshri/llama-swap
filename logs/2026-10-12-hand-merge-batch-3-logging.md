# 2026-10-12 — Hand-merge batch 3 (multi-stream logging, bbdb55d #1172)

## Goal

Port the logging rework: log data off /api/events onto
/api/events/logs?stream=…, one logmon.Group on the Server, logs.toStdout
config. Then adapt the vanilla UI's SSE layer.

## Change

- Pick bbdb55d. Clean: logmon/group.go(+tests), config (+logtostdout
  tests), router/group.go, api.go, capabilities.go, selector.go,
  llama-swap.go, apigroup.go, apigroup_test.go (the #1215-trimmed tests
  came home, as predicted), log_test.go, matrix.go (signature only).
- Resolved: server.go New() (theirs' logmon.Group + our *store.Store),
  log.go (error convention + marker kept), README (ours, both hunks),
  KB date, test helpers (their NewGroup + our store.New), matrix.go body
  proxylog -> logs.ProxyLogs, 6× s.proxylog/muxlog/upstreamlog renames,
  translate_test.go struct literal.
- ui: Svelte stores removed; api.js gains logEventSource
  (/api/events/logs?stream=proxy&stream=upstream, own backoff, same
  envelope); logData case dropped from the main handler; log-store resets
  moved to the log stream's onopen (replayed history can't be cleared by
  the other stream's onopen).

## Symptom → diagnosis (test race)

TestServer_APILogEvents_NoHistory flaked under package load: UPSTREAMHIST
arrived as a LIVE event. Monitor delivery is async (Write -> broadcastCh
(1024) -> publish goroutine) so a pre-subscription write can publish after
subscribe. Fix: probe subscriber drains the history write's broadcast
before serveLogEvents runs (deterministic; 2s probe timeout).

## Commands

```
git cherry-pick bbdb55d          # resolutions per above
go test ./internal/server/ -run TestServer_APILogEvents -count=1  (x6)
go test -short ./...             # 1968/32 ok
go build -o build/llama-swap . ; <restart server>
curl /api/events/logs?stream=proxy   # SSE + history
timeout 5 curl -N /api/events | grep -c logData   # 0
playwright: open /ui/#/logs          # history renders, no page errors
GOOS={linux,darwin,windows} gosec -quiet ./...    # 0
aidc-scan --all                                      # clean
python3 /tmp/opencode/run_selftest.py               # 152/152
```

## Verification

All gates green (see DETAILED_CHANGELOG entry). Server-start gotcha
recurred: build+start in one command hit the tool timeout mid-build;
build and start must be separate commands.

## Notes

- Remaining queue: d3ab665 (loading progress) — the last big one, largest
  vanilla-UI port; then upstream is fully caught up except changelog
  tooling and intentionally skipped subsystems (tailcat, kubeswap).
- The http log stream exists server-side; the vanilla UI subscribes to
  proxy+upstream only (parity with the old behavior). Adding an http tab
  to the logs page is a small follow-up if wanted.
