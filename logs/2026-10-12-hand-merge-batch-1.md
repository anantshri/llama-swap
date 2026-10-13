# 2026-10-12 — Hand-merge batch 1 (content-type, browser headers, decision models)

## Goal

Three upstream picks each needing one small manual resolution (user approved
all resolutions, incl. extending the content-type middleware to the
translated routes and trimming the #1172-dependent test hunk).

## Change

- `0ab9b16` = 486376e #1194 content-type autofill:
  - contenttype.go(+tests) and the modelMWs wiring applied clean.
  - Conflict was upstream's Tailcat-context code (absent subsystem) —
    dropped wholesale.
  - Fork extension: `createContentTypeMiddleware()` runs FIRST in
    `translatedDispatch` (Anthropic /v1/messages + Ollama routes).
  - New test: TestServer_AnthropicMessages_MissingContentTypeTolerated.
- `ce84b20` = d34ddb2 #1215 strip browser headers:
  - peer.go/cors.go(+tests) clean; apigroup_test conflict was #1172's
    serveLogEvents helper + 3 APILogEvents tests + logData assertion in
    upstream context — trimmed (returns with #1172); removed orphaned
    `bytes` import.
- `69e162b` = b51dde4 #1220 decision models:
  - model_config.go splice knot (shared closing brace): kept our
    ModelReasoningConfig block AND their validOutModalities intact.
  - config-schema enum: image → image,video,decisions (matches merged Go
    validation); KB tags merged; clef fixtures clean.

## Commands

```
git cherry-pick 486376e && <resolve: drop tailcat block, extend translatedDispatch>
git cherry-pick d34ddb2 && <resolve: drop #1172 test hunk, rm bytes import>
git cherry-pick b51dde4 && <resolve: splice knot, schema, tags>
go test -short ./...          # 1926/32 ok
GOOS={linux,darwin,windows} gosec -quiet ./...   # 0
aidc-scan                     # clean
```

## Verification

- Full short suite 1926 passed / 32 packages (includes the new
  missing-content-type translation test and upstream's clef/browser-header
  tests).
- gosec 0 ×3; aidc-scan clean; gofmt clean; config-schema.json valid JSON.

## Notes

- Upstream's 486376e also threaded `prepareModelBody` into their Tailcat
  handler — dropped with the tailcat block; nothing here references it.
- The trimmed #1172 assertions are tracked to return with `bbdb55d`.
- Remaining queue: `e054c90` (drop kubeswap hunk), `bea6428` (auto:orphans
  semantic merge), `bbdb55d` (logging + vanilla SSE/UI adaptation),
  `d3ab665` (loading progress, largest UI port), `0ac43bb` (docker).
