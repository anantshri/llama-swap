# 2026-10-16 — MLX speeds unknown in Activity (oMLX as the fix)

## Symptom

With an MLX backend behind llama-swap, the Activity page shows no
prompt-processing or token-generation speed for any request (both columns
unknown). Reported by the user; deployment target is an Apple Silicon Mac.

## Diagnosis

llama-swap only records throughput a backend reports — llama-server
`timings`, vLLM `metrics`, TabbyAPI `*_per_sec`, oMLX `*_per_second`
(`internal/server/metrics.go`, `buildMetrics`). Verified against mlx-lm
`server.py` (main): the stock `mlx-lm server` usage block carries only
`prompt_tokens`, `completion_tokens`, `total_tokens`,
`prompt_tokens_details.cached_tokens` — no rate or timing fields anywhere;
in streaming mode the usage chunk only appears with
`stream_options: {"include_usage": true}`, and prefill progress is SSE
comment lines (`: keepalive n/total`) the parser rightly skips. So the
speeds are unknowable from a stock mlx-lm response.

oMLX (`jundot/omlx`, `omlx/server.py` @ main) emits
`usage.prompt_tokens_per_second` (uncached prompt ÷ prefill) and
`usage.generation_tokens_per_second` (completion ÷ generation) in every
non-streaming response, and in streams behind
`stream_options.include_usage` (llama-swap injects that flag for
`/v1/messages` and Ollama clients). It serves `GET /health` (503 while
preloading). This fork already parses both fields (upstream #1199,
cherry-pick `783c323`).

A proxy-side fallback (TTFT via first write in `responseBodyCopier`,
wall-clock rate derivation in `buildMetrics`) was proposed; user chose the
config workaround + oMLX entry instead.

## Change

```diff
+ docs/kb/guides/upstreams/omlx.md          (new guide)
```

`docs/config.example.yaml` — oMLX example model after the vLLM-omni block:

```yaml
  "qwen3-coder-next-8bit":
    cmd: |
      /opt/homebrew/bin/omlx serve
      --model-dir /Users/yourname/models --port ${PORT}
    aliases:
      - gpt-oss-120b-mxfp4-q8
      - step-3.5-flash-8bit
```

Key mechanics the docs rely on (verified in code): `cmd` runs via
`exec.CommandContext` with no shell, so paths are absolute; with
`useModelName` unset the requested model name passes through unchanged
(`internal/server/filters.go`), so one oMLX process serves a whole
`--model-dir` through `aliases`; `checkEndpoint` default `/health` matches
oMLX's endpoint; `includeAliasesInList` controls alias visibility in
`/v1/models`.

## Commands

    go test ./internal/docagent/ -run TestKB          # 28 passed
    go test ./internal/config/ -run "Example|Schema"  # TestConfig_ExampleMatchesSchema ok
    go build ./...                                    # clean

## Verification

All three commands pass on first run after the edits. No Go code changed;
docs-only diff.

## Notes

- Headless Chromium (Chrome for Testing 155, linux-arm64) installed at
  `~/.local/bin/chromium` for JS-rendered fetching — `/opt/toolchains` is
  read-only, and the first install attempt used an x86_64 build (this
  container is arm64; OrbStack reported the loader mismatch). Needed
  `fontconfig fonts-dejavu-core` to stop a Skia font-manager crash.
- oMLX is itself a multi-model server (continuous batching, LRU eviction,
  pinning): under llama-swap the whole process is the swap unit, which the
  guide calls out — one entry + aliases, never one entry per model.
- If stock mlx-lm must stay: speeds remain unknown by design; streaming
  counts require clients to send `stream_options.include_usage`.
