---
title: MLX speeds in Activity with oMLX
summary: The stock mlx-lm server reports only token counts, so Activity speeds stay unknown; oMLX reports real prompt and generation rates.
category: guides
tags: [mlx, omlx, apple-silicon, mac, metrics, activity, upstream]
config_keys: [models.*.cmd, models.*.aliases, models.*.checkEndpoint, models.*.proxy, includeAliasesInList]
updated: 2026-10-16
---

# MLX speeds in Activity with oMLX

On a Mac, an MLX backend comes in two flavors, and they behave very differently
in llama-swap's Activity page:

| backend | usage fields | Activity prompt/gen speed |
| --- | --- | --- |
| [oMLX](https://github.com/jundot/omlx) | counts **plus** `prompt_tokens_per_second`, `generation_tokens_per_second` | shown |
| stock `mlx-lm server` | counts only | unknown |

llama-swap records throughput the backend reports: llama-server `timings`, vLLM
`metrics`, TabbyAPI and oMLX usage rate fields. The stock `mlx-lm server` has
none of them — its `usage` carries only token counts (`prompt_tokens`,
`completion_tokens`, `total_tokens` and `prompt_tokens_details.cached_tokens`),
and in streaming mode even those only arrive when the client sends
`stream_options: {"include_usage": true}` (its prefill progress is SSE comment
lines, which carry no data). No rate fields anywhere means both speed columns
read unknown, and there is nothing to configure around it on the llama-swap
side. oMLX reports both rates, so it is the MLX backend to use when you want
the speeds.

## Setup

Install oMLX and put MLX-format models in one directory, one subdirectory per
model:

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
mkdir -p ~/models   # e.g. mlx-community/Qwen3-Coder-Next-8bit → ~/models/Qwen3-Coder-Next-8bit
```

One llama-swap entry starts one oMLX process that serves every model in that
directory. The entry's ID must match the subdirectory you want listed; list the
rest as `aliases` so requests naming them reach the same process:

```yaml
models:
  qwen3-coder-next-8bit:
    # no shell: use an absolute path, ~/ does not expand
    cmd: |
      omlx serve --model-dir /Users/you/models --port ${PORT}
    aliases:
      - gpt-oss-120b-mxfp4-q8
      - step-3.5-flash-8bit
```

Names pass through unchanged when `useModelName` is unset, so oMLX sees
exactly what the client asked for — list every model directory you want
routable (or an oMLX admin-panel alias mirrored here) in `aliases`. Turn on
`includeAliasesInList` if you want the aliases to appear in `/v1/models` too.

oMLX serves `GET /health` (503 while preloading), which is the default
`checkEndpoint`, so nothing needs setting there. With `--port ${PORT}` the
default `proxy` works as well.

## What lands in Activity

oMLX computes the rates itself: prompt speed counts only uncached prompt tokens
over prefill time, generation speed is completion tokens over generation time.
Every non-streaming response carries them, so the Activity page shows real
prompt and generation tok/s with no extra settings. In streams they ride the
final usage chunk, which oMLX — like mlx-lm — only emits when the client asks
for it with `stream_options: {"include_usage": true}`. llama-swap adds that
flag for you on the Anthropic `/v1/messages` and Ollama endpoints; OpenAI-SDK
streaming clients must opt in themselves or the turn records no counts and no
rates.

## What goes wrong

- **`omlx: command not found` in the model log.** Homebrew puts it in
  `/opt/homebrew/bin`; llama-swap does not run `cmd` through a shell, so the
  search path may differ. Use the absolute path in `cmd`
  (`/opt/homebrew/bin/omlx serve ...`).
- **A model 404s although it is in the directory.** llama-swap answers with
  its own 404 for names it does not know — the request never reaches oMLX.
  Requested names must be the entry ID or one of its `aliases`; if you rename
  a model in oMLX's admin panel, mirror that alias here too.
- **Swapping unloads every model oMLX was serving.** oMLX is itself
  multi-model with continuous batching, LRU eviction and pinning; under
  llama-swap the whole process is the unit of swapping. One entry plus aliases
  keeps that to a single process — defining a second oMLX entry would start a
  second server. Prefer oMLX-side controls (`--max-concurrent-requests`,
  `--memory-guard`, model pinning) for tuning inside the process.
- **The admin dashboard is unreachable.** It lives on the same port as the
  API; reach it through llama-swap's `/upstream/<model>/` passthrough.
- **Stock mlx-lm and stuck with it?** Speeds stay unknown (no fields to read),
  and streaming token counts only appear when clients send
  `stream_options: {"include_usage": true}` — the same flag oMLX needs in a
  stream, but with oMLX there are rates waiting behind it. The chat UI's live
  per-turn stats estimate speeds client-side regardless.

## Related

- `guides/connectivity/upstream-passthrough` — reaching an upstream's own UI
- `guides/model-runtime/writing-cmd` — how `cmd` runs (no shell, macros)
- `guides/operations/observability-storage-and-activity` — where Activity data lives
