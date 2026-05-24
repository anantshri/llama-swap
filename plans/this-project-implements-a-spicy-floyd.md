# Ollama API Compatibility Layer

## Context

llama-swap is already a drop-in replacement for OpenAI- and Anthropic-compatible
environments — both work because llama.cpp's upstream server natively serves
`/v1/chat/completions` *and* `/v1/messages` (added in
[llama.cpp #17570](https://github.com/ggml-org/llama.cpp/pull/17570)). The proxy
does no translation; it just routes by `model` and forwards the body.

Ollama compatibility is **fundamentally different**: llama.cpp's upstream does
not speak the Ollama wire protocol. Adding Ollama compatibility therefore
requires llama-swap to do actual request/response translation — request bodies
must be rewritten from Ollama shape into OpenAI shape, and streaming responses
must be reformatted from SSE into NDJSON.

The goal is for tools coded against the Ollama API (Open WebUI, n8n nodes,
LangChain `Ollama`, VS Code Continue, Zed assistant, etc.) to use llama-swap
without modification.

## What is possible

| Ollama endpoint | Strategy | Notes |
|---|---|---|
| `POST /api/chat` | **Translate** → `/v1/chat/completions` | Maps cleanly; `options.*` → top-level params |
| `POST /api/generate` | **Translate** → `/v1/chat/completions` | Build a single-message conversation; honour `system`, `template`, `raw` |
| `POST /api/embed` | **Translate** → `/v1/embeddings` | `input` (string\|array) → `input`; rename `embeddings` array on response |
| `POST /api/embeddings` (legacy) | **Translate** → `/v1/embeddings` | `prompt` → `input`; response uses `embedding` (singular) |
| `GET /api/tags` | **Native** | Built from `pm.config.Models`, same source as `/v1/models` |
| `POST /api/show` | **Native** | Built from `ModelConfig` (name, description, metadata); placeholder modelfile/template |
| `GET /api/ps` | **Native** | Walk process groups; report whichever model is currently loaded |
| `GET /api/version` | **Native** | Return a fixed Ollama-shaped `{"version":"..."}`; clients only check presence |

## What is NOT possible

These endpoints require local model file management that llama-swap deliberately
does not do (models are external processes started by user-defined `cmd`):

- `POST /api/create`, `POST /api/copy`, `DELETE /api/delete`
- `POST /api/pull`, `POST /api/push`
- `HEAD /api/blobs/:digest`, `POST /api/blobs/:digest`

These will be wired up to return **HTTP 501 Not Implemented** with an Ollama-shaped
error body, so clients fail loudly rather than hang. Tests assert this contract.

## Architecture

New subpackage `proxy/ollama/` containing:

```
proxy/ollama/
  types.go          // Ollama request/response struct types
  translate.go      // OpenAI <-> Ollama body conversion (pure functions)
  stream.go         // SSE -> NDJSON streaming translator
  handlers.go       // Gin handler factories; accept *ProxyManager via interface
  *_test.go         // unit + httptest coverage
```

Handlers do **not** open new HTTP connections. They translate the body, then
invoke the existing internal pipeline that `mkProxyJSONHandler`
(`proxy/proxymanager.go:755-904`) uses: resolve `modelID` via
`pm.config.RealModelName`, get the `ProcessGroup` via `pm.swapProcessGroup`,
apply `useModelName` / `filters.stripParams` / `filters.setParams`, then call
`processGroup.ProxyRequest`. To avoid duplicating that ~150-line block, the
relevant logic in `proxymanager.go` is extracted into a small helper
`(pm *ProxyManager) dispatchJSON(c *gin.Context, bodyBytes []byte, captureFields)`
that both the existing JSON handler and the new Ollama handlers call.

For streaming responses, the Ollama handler wraps `c.Writer` in a
`SSEToNDJSONWriter` that:
1. Buffers incoming bytes from the upstream reverse-proxy response.
2. Parses each `data: {...}` SSE frame.
3. Converts to an Ollama chunk (`{"model":...,"message":{...},"done":false}`).
4. Flushes each frame as `<json>\n` to the downstream client.
5. On `data: [DONE]`, emits a final `{"done":true,...timings}` chunk.

The writer must be installed *before* `processGroup.ProxyRequest` calls
`ReverseProxy.ServeHTTP`, so the reverse proxy writes through it. The existing
`process.go:121-127` `ModifyResponse` hook (sets `X-Accel-Buffering: no` on
`text/event-stream`) does **not** need to change — the SSE comes from upstream
to us; we control what goes downstream.

## Request translation specifics

### `/api/chat` → `/v1/chat/completions`

```
ollama field          → openai field
model                 → model           (passthrough; subject to UseModelName)
messages              → messages        (role+content shape is identical;
                                         images[] in user msg → content parts
                                         with type:"image_url")
stream                → stream
tools                 → tools
format ("json")       → response_format: {"type":"json_object"}
format (schema object)→ response_format: {"type":"json_schema","json_schema":{...}}
keep_alive            → DROP (handled by llama-swap TTL, not upstream)
options.temperature   → temperature
options.top_p         → top_p
options.top_k         → DROP (llama.cpp supports via param; passthrough if set)
options.num_predict   → max_tokens
options.stop          → stop
options.seed          → seed
options.num_ctx       → DROP (model-launch param, not request param)
options.* (other)     → DROP with debug log
```

### `/api/generate` → `/v1/chat/completions`

Build `messages` as `[{role:"system",content:system}, {role:"user",content:prompt}]`
(omit system message if empty). `raw:true` means "no template" — send `prompt`
verbatim with no system role. `suffix` and `images` handled per Ollama docs.
`template` is ignored (templating is upstream's job).

### `/api/embed` and `/api/embeddings`

`/api/embed`: `input` passes through (string or array). Response: take
`data[].embedding` from OpenAI shape, return as `{"embeddings": [...]}`.

`/api/embeddings` (legacy): rewrite `prompt` → `input`. Response uses singular
`embedding` (one vector, not array of vectors).

## Response translation specifics

### Non-streaming chat

OpenAI:
```json
{"id":"...","choices":[{"message":{"role":"assistant","content":"..."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":N,"completion_tokens":M}}
```

Ollama:
```json
{"model":"...","created_at":"2026-05-23T...","message":{"role":"assistant","content":"..."},
 "done":true,"done_reason":"stop",
 "prompt_eval_count":N,"eval_count":M,
 "total_duration":..., "load_duration":0,"prompt_eval_duration":0,"eval_duration":0}
```

Timing fields that llama-swap cannot derive (load_duration, prompt_eval_duration,
eval_duration) are set to `0`. `total_duration` is measured from request start.

### Streaming chat (NDJSON output)

Each upstream SSE `delta` frame becomes one NDJSON line:
```json
{"model":"...","created_at":"...","message":{"role":"assistant","content":"<delta>"},"done":false}
```
Final frame (on SSE `[DONE]` or `finish_reason` present):
```json
{"model":"...","created_at":"...","message":{"role":"assistant","content":""},
 "done":true,"done_reason":"stop","total_duration":...,
 "prompt_eval_count":...,"eval_count":...}
```

Token counts come from the last SSE chunk that contains `usage` (llama.cpp emits
this when `stream_options.include_usage=true` is set — the handler injects this
flag before forwarding).

### `/api/tags` shape

```json
{"models":[{"name":"qwen3:8b","model":"qwen3:8b","modified_at":"...","size":0,
            "digest":"","details":{"format":"gguf","family":"","parameter_size":"","quantization_level":""}}]}
```
`size`/`digest` are zero/empty (llama-swap has no GGUF metadata). Built from
`pm.config.Models`, mirrors the `listModelsHandler` loop at
`proxy/proxymanager.go:588-667` (skip `Unlisted`, include aliases when
`IncludeAliasesInList`, include peer models).

### `/api/ps` shape

Walk `pm.processGroups` (or matrix state) and report any group where a
process is currently running. State exposed in `proxy/processgroup.go` —
`ProcessGroup.currentProcess` or equivalent (verify exact field at implementation).

### `/api/version`

```json
{"version":"0.5.0-llama-swap"}
```
Faked. Some clients gate features on `>=0.x.y`; pick a version above the
current Ollama release at implementation time.

## Critical files

**New files:**
- `proxy/ollama/types.go` — request/response struct definitions
- `proxy/ollama/translate.go` — pure conversion functions (unit-testable)
- `proxy/ollama/stream.go` — `SSEToNDJSONWriter` implementing `http.ResponseWriter`
- `proxy/ollama/handlers.go` — `RegisterRoutes(*gin.RouterGroup, Dispatcher)` factory
- `proxy/ollama/translate_test.go`, `stream_test.go`, `handlers_test.go`

**Modified files:**
- `proxy/proxymanager.go`:
  - Extract the body-dispatch block (currently lines 755-902 inside `mkProxyJSONHandler`) into a reusable `dispatchJSON` method on `ProxyManager`. Keep `mkProxyJSONHandler` as a thin wrapper calling `dispatchJSON`. **Goal: no behavior change for existing routes — verified by existing tests.**
  - In `setupGinEngine`, after the existing route block (~line 367), add:
    ```go
    ollama.RegisterRoutes(pm.ginEngine.Group(""), pm)  // pm implements ollama.Dispatcher
    ```
- `proxy/proxymanager.go`: implement `ollama.Dispatcher` interface (Models(), RealModelName(), Dispatch(modelID, body, ctx)).

**Reused without modification:**
- `proxy/process.go` — reverse proxy unchanged
- `proxy/processgroup.go` — swap mechanism unchanged
- `proxy/config/*` — no config schema additions needed (compat is on-by-default
  like OpenAI/Anthropic; controlled at route level only)

## Phased delivery

Single PR is fine but commits should be phased to keep review tractable:

1. **Refactor commit**: extract `dispatchJSON` from `mkProxyJSONHandler`. No
   external behavior change. Existing tests pass unchanged.
2. **Translation core**: `proxy/ollama/types.go`, `translate.go`, full unit tests
   for non-streaming request/response conversion.
3. **Streaming translator**: `stream.go` with synthetic SSE → NDJSON tests.
4. **Inference handlers**: `/api/chat`, `/api/generate`, `/api/embed`,
   `/api/embeddings` with httptest coverage.
5. **Informational handlers**: `/api/tags`, `/api/show`, `/api/ps`, `/api/version`.
6. **501 stubs**: register the management endpoints with a shared
   `notImplementedHandler` returning Ollama-shaped error.

## Verification

**Unit tests** (`go test ./proxy/ollama/...`):
- Translation: a table-driven test per direction (chat req in/out, generate
  req in/out, embed req/resp, options.* mapping, format/json mapping,
  images-in-message mapping).
- Streaming: feed canned SSE bytes, assert NDJSON output line-by-line including
  a final `done:true` frame with correct token counts.

**Integration tests** (`proxy/ollama/handlers_test.go`, follows the
`httptest.NewRequest`/`pm.ServeHTTP` pattern at `proxy/proxymanager_test.go:60-100`):
- `POST /api/chat` with `stream:false` → matched Ollama response shape, model
  swap actually triggered (use existing mock process group helpers).
- `POST /api/chat` with `stream:true` → NDJSON sequence, terminating frame,
  token usage propagated.
- `POST /api/generate` with `system`/`raw` variants.
- `POST /api/embed` (array input) and `POST /api/embeddings` (singular).
- `GET /api/tags` → contains every non-`Unlisted` model from config.
- `POST /api/show` for known/unknown model (404).
- `GET /api/ps` with no model loaded / one model loaded.
- `POST /api/pull` → 501 with Ollama-shaped error body.

**Manual end-to-end** (documented in PR description, not automated):
- Run `llama-swap` against the existing example config.
- Point `OLLAMA_HOST=http://localhost:8080` and exercise:
  - `ollama list` (uses `/api/tags`)
  - `ollama ps` (uses `/api/ps`)
  - `ollama run <model> "hello"` (uses `/api/chat` streaming)
  - One real Ollama client — Open WebUI is the canonical proof.

**Required checks before PR**:
- `gofmt -l .` clean
- `make test-dev` passes (runs `go test` + `staticcheck`)
- `make test-all` passes
- No changes to `ui-svelte/` required.

## Open questions deferred to implementation

- Exact set of `options.*` keys to forward as top-level params vs drop —
  start strict (drop unknowns with debug log), expand based on real client
  traffic.
- Whether `/api/show` should advertise capabilities like `vision`/`tools`
  based on model metadata (config doesn't expose this today; could read from
  `modelConfig.Metadata`).
- Whether `keep_alive` from Ollama requests should override the model's
  configured `ttl` for this request — defer; document as ignored for now.
