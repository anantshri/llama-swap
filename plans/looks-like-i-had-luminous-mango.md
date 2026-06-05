# Plan: Translate Anthropic client requests to OpenAI backends

## Context

llama-swap is **not** an API-routing/translation layer today. It picks the
*incoming* API format purely from the route that was hit, and it assumes every
upstream backend speaks **OpenAI**. The only real translation that exists is the
Ollama compatibility layer (`proxy/ollama/`), which converts incoming Ollama
requests → OpenAI, dispatches, and converts the response back (streaming +
buffered). Anthropic's `/v1/messages` is currently **passed through raw**,
relying on llama.cpp's native Anthropic endpoint — so a Claude/Anthropic client
cannot talk to a backend that only speaks OpenAI (most llama.cpp/vLLM setups).

This change adds the first real cross-protocol translation: an operator declares
that a model's upstream speaks OpenAI, and an **Anthropic client** (e.g. Claude
Code) can hit `/v1/messages` and have it transparently translated to
`/v1/chat/completions`, with the OpenAI response (streaming and non-streaming)
translated back into Anthropic shape.

**Scope (confirmed with user):**
- Direction: **Anthropic client → OpenAI backend** only (one leg of a larger
  matrix; package is structured so other legs can be added later).
- **Streaming required** (Anthropic SSE event framing) plus buffered.
- **Chat completions only** (`/v1/messages` → `/v1/chat/completions`).
  Embeddings, `count_tokens`, audio, images, rerank are out of scope and keep
  today's behavior.

## Architecture

Pivot through the OpenAI chat-completions shape as the canonical representation
(the same pivot the Ollama layer already uses). For this scope we need exactly
two converters plus a streaming writer:

1. **Anthropic request → OpenAI request** (`/v1/messages` body → `/v1/chat/completions` body)
2. **OpenAI response → Anthropic response** (buffered JSON)
3. **OpenAI SSE → Anthropic SSE** (streaming)

The request/response interception reuses the proven `proxy/ollama` writer
pattern: `BufferingWriter` for non-streaming, a `StreamWriter`-style wrapper for
streaming.

### New package: `proxy/apiconv`

```
proxy/apiconv/
  apiconv.go        // Format enum (FormatOpenAI, FormatAnthropic, FormatOllama); needsTranslation(in,out)
  anthropic_types.go// typed Anthropic request/response/SSE-event structs (subset we use)
  anthropic_req.go  // AnthropicToOpenAIRequest([]byte) ([]byte, error)
  anthropic_resp.go // OpenAIToAnthropicResponse(body []byte, model string) ([]byte, error)  (buffered)
  anthropic_stream.go// AnthropicStreamWriter: wraps gin.ResponseWriter, OpenAI SSE -> Anthropic SSE
  buffer.go         // BufferingWriter (copied/extracted from proxy/ollama/buffer.go; it is format-neutral)
```

`anthropic_stream.go` reuses the SSE frame-buffering loop and the
`openaiStreamChunk` parse struct from `proxy/ollama/stream.go:82-169` (the input
side is identical — OpenAI SSE). Only the *emit* side differs: instead of NDJSON
it emits Anthropic event frames.

> Reuse note: `proxy/ollama/buffer.go`'s `BufferingWriter` is fully
> format-neutral (no Ollama specifics). Prefer extracting it into `apiconv` and
> having `proxy/ollama` import it, to avoid two copies. If that refactor is
> deemed risky, copy it into `apiconv` and leave the Ollama one untouched.

## Config

Add one field to `ModelConfig` (`proxy/config/model_config.go:23-57`):

```go
// BackendApi declares the API format the upstream process speaks.
// One of "openai" (default), "anthropic", "ollama". When the incoming
// request format differs from this, llama-swap translates request+response.
BackendApi string `yaml:"backendApi"`
```

- **Default:** set `BackendApi: "openai"` in the `defaults` literal of
  `UnmarshalYAML` (`proxy/config/model_config.go:59-97`).
- **Constants + validation:** add exported constants in the `config` package
  (mirror the `LogToStdout*` constants at `proxy/config/config.go:19-24`):
  `BackendApiOpenAI`, `BackendApiAnthropic`, `BackendApiOllama`. Validate in the
  per-model loop in `LoadConfigFromReader` (`proxy/config/config.go:273-455`,
  next to the existing TTL/proxy checks): lowercase/trim, reject anything not in
  the set with a clear error.

### Backward-compatibility note (must document)

Default `backendApi: openai` means `/v1/messages` requests are now **translated**
to `/v1/chat/completions` instead of passed through. For users who relied on
llama.cpp's *native* `/v1/messages`, this still works (the backend also serves
`/v1/chat/completions`). To keep raw pass-through to a native Anthropic backend,
set `backendApi: anthropic` on that model (incoming == backend ⇒ no translation).
Call this out in `README.md` and `config.example.yaml`.

## Dispatch wiring

The incoming format is known at the route level; the backend format is only
known after model resolution inside `DispatchJSON`. Thread the incoming format
into dispatch:

1. **Tag the Anthropic routes with their format.** In `setupGinEngine`
   (`proxy/proxymanager.go:340-367`), add a format-aware handler constructor,
   e.g. `mkProxyJSONHandlerFmt(cf captureFields, in apiconv.Format)`. Point
   `/v1/messages` and `/v/messages` at `FormatAnthropic`. Leave
   `/v1/messages/count_tokens` on the existing pass-through handler (out of
   scope). All other LLM routes stay on the current handler (= `FormatOpenAI`).

2. **Generalize dispatch.** Rename the body of `DispatchJSON`
   (`proxy/proxymanager.go:788-934`) into `DispatchJSONWithFormat(c, body, cf,
   in apiconv.Format)` and keep `DispatchJSON` as a wrapper that calls it with
   `FormatOpenAI` (so `ollamaDispatcher` at `proxy/proxymanager.go:1272` and
   existing callers are unchanged — the Ollama layer already translates to
   OpenAI before dispatching).

3. **Translate when formats differ.** Inside the `if found` branch, after model
   resolution (`proxy/proxymanager.go:798`) read
   `backend := pm.config.Models[modelID].BackendApi`. Then, **before** the
   `useModelName`/stripParams/setParams block (`:813-860`) so operator filters
   apply to the OpenAI body actually sent upstream:
   - If `in == backend` (e.g. Anthropic client + `backendApi: anthropic`):
     behave exactly as today (raw pass-through). Preserves backward compat.
   - If `in == FormatAnthropic && backend == FormatOpenAI`:
     1. `bodyBytes, err = apiconv.AnthropicToOpenAIRequest(bodyBytes)`
     2. set `c.Request.URL.Path = "/v1/chat/completions"`
     3. capture streaming intent from the **incoming** body
        (`gjson.GetBytes(body, "stream")`) before translation, since the
        response writer needs it in the client's terms.
     4. install the response-translating writer (below) by swapping `c.Writer`,
        mirroring `runStreaming`/`runBuffered` in
        `proxy/ollama/handlers.go:249-284`.
   - Any other mismatch is out of scope → return today's behavior (pass-through)
     so nothing breaks; future phases fill these in.

4. **Response interception** (swap `c.Writer` before the existing metrics +
   dispatch tail at `proxy/proxymanager.go:903-933`, so the metrics monitor sees
   the **client-format/translated** bytes — which `metrics_monitor.go`'s
   `extractUsageTokens`/`usagePaths` already understand for Anthropic):
   - **Streaming:** `apiconv.NewAnthropicStreamWriter(c.Writer, model)`. Parses
     OpenAI SSE `data:` frames (reuse the loop + `openaiStreamChunk` from
     `proxy/ollama/stream.go`), emits Anthropic events. `Finalize()` in a defer.
   - **Buffered:** `apiconv.BufferingWriter`; after dispatch, on 2xx call
     `OpenAIToAnthropicResponse` and `CommitTranslated(..., "application/json",
     200)`; on non-2xx `CommitPassThrough()` (preserve upstream error).

## Translation details

### Anthropic request → OpenAI request (`anthropic_req.go`)
- **System prompt:** hoist Anthropic top-level `system` (string or content-block
  array) into a leading `{"role":"system","content":...}` message.
- **Messages:** map `messages[]`; convert content-block arrays to OpenAI content
  (text → string or `text` parts; `image` block `source{base64,media_type,data}`
  → `image_url` data URL).
- **Tools:** `tools[].input_schema` → `tools[].function.parameters` (+ name,
  description, `type:"function"`); `tool_choice` mapping.
- **tool_use / tool_result:** Anthropic assistant `tool_use` block →
  `assistant.tool_calls[].function`; user `tool_result` block →
  `{"role":"tool","tool_call_id":...,"content":...}`. Thread tool-call IDs.
- **Params:** `max_tokens` → `max_tokens`; `temperature`/`top_p`/`stop_sequences`
  → `stop`; pass `stream` through; set `stream_options.include_usage=true` when
  streaming (so usage arrives for the final Anthropic `message_delta`).

### OpenAI response → Anthropic response (`anthropic_resp.go`, buffered)
- Build `{"type":"message","role":"assistant","model":...,"content":[...],
  "stop_reason":...,"usage":{input_tokens,output_tokens}}`.
- `choices[0].message.content` → a `text` content block; `tool_calls` →
  `tool_use` content blocks (parse `function.arguments` JSON into `input`).
- `finish_reason` → `stop_reason` (`stop`→`end_turn`, `length`→`max_tokens`,
  `tool_calls`→`tool_use`).
- `usage.prompt_tokens`→`input_tokens`, `usage.completion_tokens`→`output_tokens`,
  cached tokens → `cache_read_input_tokens` when present.

### OpenAI SSE → Anthropic SSE (`anthropic_stream.go`, streaming)
Emit the Anthropic event sequence as OpenAI chunks arrive:
- On first delta: `message_start` (id, model, empty usage) → `content_block_start`
  (index 0, `text`).
- Each `delta.content` → `content_block_delta` `{type:"text_delta",text}`.
- `delta.tool_calls` → open a `tool_use` content block and stream
  `input_json_delta.partial_json` (OpenAI streams the tool name once, arguments
  incrementally — accumulate by index).
- On `finish_reason`/`[DONE]`: `content_block_stop` → `message_delta`
  (mapped `stop_reason` + `usage.output_tokens` from the final usage chunk) →
  `message_stop`.
- `WriteHeader`: pass through unchanged if upstream is not `text/event-stream`
  (preserve error bodies) — reuse the guard at `proxy/ollama/stream.go:67-78`.
- `Finalize()`: emit closing events if upstream closes without `[DONE]`.

## Critical files

- `proxy/config/model_config.go` — add `BackendApi` field + default.
- `proxy/config/config.go` — constants + validation.
- `proxy/proxymanager.go` — `mkProxyJSONHandlerFmt`, `DispatchJSONWithFormat`,
  route tagging for `/v1/messages` + `/v/messages`, writer-swap helpers.
- `proxy/apiconv/` — **new package** (request/response/stream converters + types).
- `proxy/ollama/stream.go`, `proxy/ollama/buffer.go` — patterns reused (and
  `BufferingWriter` ideally extracted into `apiconv`).
- `proxy/metrics_monitor.go` — verify Anthropic-SSE-out usage parsing
  (`extractUsageTokens`/`usagePaths`/`processStreamingResponse`); extend if a
  test shows event-framed usage is missed.
- `README.md`, `config.example.yaml` — document `backendApi` + the
  `/v1/messages` behavior change.

## Staging

1. **Config plumbing** (`BackendApi` field, default, constants, validation) +
   config tests. No behavior change.
2. **`apiconv` skeleton + dispatch threading**: `Format` enum,
   `DispatchJSONWithFormat`, route tagging, `in==backend` short-circuit. Default
   `openai` ⇒ behavior unchanged for OpenAI clients; Anthropic clients short-
   circuit to today's pass-through until step 3 lands.
3. **Buffered Anthropic→OpenAI**: `AnthropicToOpenAIRequest` +
   `OpenAIToAnthropicResponse` + `BufferingWriter` wiring. Non-streaming
   `/v1/messages` against an OpenAI backend works end to end.
4. **Streaming**: `AnthropicStreamWriter` (OpenAI SSE → Anthropic SSE) + wiring.
5. **Tools + multimodal + polish**: tool_use/tool_result round-trip, image
   blocks, error-shape translation (optional), docs.

Each phase compiles and passes tests.

## Verification

- **Unit (table-driven, golden fixtures)** in `proxy/apiconv` (mirror
  `proxy/ollama/translate_test.go` / `stream_test.go`):
  - `TestAnthropicToOpenAIRequest_*` — system hoist, content blocks, tools,
    tool_result, images, params.
  - `TestOpenAIToAnthropicResponse_*` — text, tool_use, stop_reason, usage.
  - `TestAnthropicStreamWriter_*` — chunk SSE arbitrarily across `Write` calls
    (frame buffering), pass-through on non-SSE content type, finalize without
    `[DONE]`, tool-call streaming.
- **Dispatch e2e** in `proxy/proxymanager_test.go` (naming
  `TestProxyManager_*`): fake OpenAI upstream; send `/v1/messages` with
  `backendApi: openai`; assert upstream received OpenAI-shaped body at
  `/v1/chat/completions` and the client received Anthropic-shaped output
  (streaming and buffered). Add a case for `backendApi: anthropic` asserting raw
  pass-through (no translation).
- **Metrics** in `metrics_monitor_test.go`: assert token counts extracted for an
  Anthropic-SSE-out stream.
- **Manual:** point Claude Code (or `curl` an Anthropic `/v1/messages` request,
  `"stream": true`) at a llama-swap model whose backend is llama.cpp/vLLM with
  `backendApi: openai`; confirm a valid Anthropic streaming response.
- **Commands:** `go test -v -run <pattern>` while iterating; `gofmt -l .`;
  `make test-dev` (proxy/ changes); `make gosec`; `make test-all` before
  completion. `make test-ui` is N/A (no UI changes).
