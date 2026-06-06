# Plan: Collapse API translation to "backend = OpenAI by default, opt-in pass-through"

## Context

The just-merged `api-routing` work added per-model API translation modeled as an
N×N matrix (`backendApi: openai|anthropic|ollama`, plus `CanTranslate(in, out)`),
but only **one** cell is implemented (Anthropic client → OpenAI backend). In
practice every local chat backend (llama.cpp, vLLM, tabbyAPI, SGLang, …) speaks
OpenAI `/v1/chat/completions` natively; a backend that speaks *only* Anthropic or
*only* Ollama and not OpenAI does not realistically exist. vLLM's Anthropic shim
is exactly the kind of janky native surface we want to route *around* by always
translating to OpenAI ourselves.

Today the three inbound paths are also inconsistent:
- **OpenAI** (`/v1/chat/completions`) → raw pass-through ✓
- **Anthropic** (`/v1/messages`) → `apiconv`, translates unless `backendApi: anthropic`
- **Ollama** (`/api/chat`, …) → `proxy/ollama`, **always** translates, no opt-out

**Goal:** assume backends speak OpenAI. Translate any non-OpenAI inbound format
(Anthropic, Ollama) down to OpenAI by default; OpenAI passes through directly.
Add two per-model boolean flags — `passthroughAnthropic` and `passthroughOllama`
(default `false`) — that, when set, forward the raw request to a backend that
natively speaks that format instead of translating. This removes the speculative
N×N machinery, makes the Ollama and Anthropic paths consistent, and keeps the
mature OpenAI-as-canonical-hub design.

> Note: `api-routing` is unreleased fork code, so `backendApi` can be removed
> outright — no backward-compatibility/alias burden.

## Decisions (confirmed with user)
- Config shape: **boolean flags** `passthroughAnthropic` / `passthroughOllama`,
  default `false` (translate). OpenAI is always assumed understood.
- Scope: **both Anthropic and Ollama** wired in this change.

## Behavior matrix (target)

| Inbound route            | flag off (default)              | flag on                          |
|--------------------------|---------------------------------|----------------------------------|
| `/v1/chat/completions`   | pass-through (always)           | n/a                              |
| `/v1/messages`           | translate Anthropic→OpenAI→back | raw pass-through to `/v1/messages` (`passthroughAnthropic`) |
| `/api/chat` etc.         | translate Ollama→OpenAI→back    | raw pass-through to `/api/*` (`passthroughOllama`) |

`/v1/messages/count_tokens` stays raw pass-through (no OpenAI equivalent), unchanged.

## Changes

### 1. Config — replace `backendApi` with two booleans
- `proxy/config/model_config.go`
  - Remove `BackendApi string` field. Add `PassthroughAnthropic bool \`yaml:"passthroughAnthropic"\`` and `PassthroughOllama bool \`yaml:"passthroughOllama"\``.
  - In `UnmarshalYAML`, drop the `BackendApi: BackendApiOpenAI` default line (bool zero value `false` is the desired default — no explicit default needed).
- `proxy/config/config.go`
  - Remove the `BackendApiOpenAI/Anthropic/Ollama` constants and the `backendApi`
    validation `switch` in `LoadConfigFromReader`. No validation needed for bools.
- `config.example.yaml`
  - Replace the `backendApi:` block with documented `passthroughAnthropic` /
    `passthroughOllama` keys (default `false`; explain: backend speaks this format
    natively → forward raw; otherwise translated to OpenAI).

### 2. `proxy/apiconv` — collapse N×N to Anthropic↔OpenAI only
Translation target is always OpenAI; drop the backend-format generality.
- `proxy/apiconv/apiconv.go`
  - Remove `ParseFormat`, `CanTranslate`, `BackendChatPath`, and the `out Format`
    parameter from the dispatch helpers. Keep a minimal surface, e.g.:
    - `AnthropicToOpenAIRequest(body) ([]byte, error)` (already exists in `anthropic_req.go`)
    - `OpenAIToAnthropicResponse(body, model) ([]byte, error)` (exists in `anthropic_resp.go`)
    - `NewAnthropicStreamWriter(w, model)` (exists in `anthropic_stream.go`)
  - Drop `Format`/`StreamTranslator` indirection that only existed to select the
    (single) implemented pair. `BufferingWriter` (`buffer.go`) stays as-is (generic).
- Keep all converter files (`anthropic_req.go`, `anthropic_resp.go`,
  `anthropic_stream.go`, `anthropic_types.go`, `buffer.go`) and their unit tests —
  they are the real value and are unaffected by removing the matrix plumbing.

### 3. `proxy/proxymanager.go` — drive translation off the inbound route + flag
- Route setup (`setupGinEngine`, ~L341–369): replace `mkProxyJSONHandlerFmt(captureAll, apiconv.FormatAnthropic)` with a clearly-named handler that tags the route as Anthropic inbound (e.g. `mkAnthropicJSONHandler(captureAll)`); `/v1/chat/completions` etc. keep the plain `mkProxyJSONHandler` (OpenAI pass-through).
- Replace `DispatchJSONWithFormat(c, body, cf, in apiconv.Format)` with a small
  inbound discriminator (a bool `inboundAnthropic`, or a tiny local enum — no
  backend `Format`). After model resolution:
  - `translate := inboundAnthropic && !pm.config.Models[modelID].PassthroughAnthropic`
  - When `translate`: convert request via `apiconv.AnthropicToOpenAIRequest`, set
    `c.Request.URL.Path = "/v1/chat/completions"` (constant, not `BackendChatPath`),
    run filters, and on the way back swap the writer for the streaming translator
    (`apiconv.NewAnthropicStreamWriter`) or the `BufferingWriter` +
    `apiconv.OpenAIToAnthropicResponse`, exactly as the current code does.
  - When not translating: existing pass-through path (writer untouched).
  - Remove all `apiconv.ParseFormat` / `CanTranslate` / `BackendChatPath` /
    `backendFmt` usage (~L816, 838–846, 982, 1009). Keep the metrics-monitor tee of
    raw upstream bytes and the upstream-error pass-through (`CommitPassThrough`).

### 4. `proxy/ollama` — add raw pass-through hook
- `proxy/ollama/handlers.go`
  - Add `PassthroughOllama bool` to `ModelInfo` (struct already flows through `FindModel`), keeping the package free of any `apiconv`/config import.
  - In `makeChatHandler` / `makeGenerateHandler` / `makeEmbedHandler` /
    `makeEmbeddingsHandler`: after resolving `req.Model`, if
    `info, ok := d.FindModel(req.Model); ok && info.PassthroughOllama` →
    **skip** `TranslateChatRequest` and the `c.Request.URL.Path` rewrite, and call
    `d.DispatchJSON(c, body)` with the **original** body (upstream is a real Ollama
    server, so its native response flows straight back to `c.Writer`, no response
    translation). Otherwise keep today's translate path unchanged.
- `proxy/proxymanager.go` (`ollamaDispatcher.FindModel` / `ListModels`, ~L1358–1399):
  populate the new `PassthroughOllama` field from `pm.config.Models[id].PassthroughOllama`.

### 5. Tests
- `proxy/config/config_test.go` / `config_posix_test.go`: replace the `backendApi`
  validation/default tests with cases for the two booleans (default `false`;
  parse `true`).
- `proxy/proxymanager_apiconv_test.go`: update to the new inbound discriminator;
  add a `passthroughAnthropic: true` case asserting `/v1/messages` is forwarded raw
  (no translation). Keep the translate-by-default assertions.
- `proxy/apiconv/*_test.go`: keep; adjust only if a removed symbol
  (`ParseFormat`/`CanTranslate`/`BackendChatPath`) was referenced.
- Add an Ollama pass-through test (in `proxy/ollama/handlers_test.go`) asserting a
  `PassthroughOllama: true` model forwards the raw `/api/chat` body untranslated.

### 6. Docs
- `README.md`: rewrite fork-changes item 4 to describe the new default
  (everything non-OpenAI translated to OpenAI; OpenAI passes through) and the two
  pass-through flags, replacing the `backendApi` description.

## Verification
- `gofmt -l .` (fix with `gofmt -w`).
- `go test -v -run 'TestProxyManager_|TestProcessGroup_|Apiconv|Ollama' ./proxy/...`
  for the touched areas, then `make test-dev` (go test + staticcheck) for the
  `proxy/` tree.
- `make gosec` (linux/darwin/windows matrix) — must stay at 0 findings.
- `make test-all` before completion (long-running concurrency tests).
- Manual smoke (optional): start with a config that has one model
  `passthroughAnthropic: false` and one `true`; `POST /v1/messages` to each and
  confirm the first returns an Anthropic-shaped body produced by translation and
  the second is forwarded raw. Repeat for `/api/chat` with `passthroughOllama`.

## Out of scope / notes
- Default flips remain consistent with current behavior (Anthropic already
  translated by default); users on a native-`/v1/messages` backend (recent
  llama.cpp) now set `passthroughAnthropic: true` to retain raw fidelity — call
  this out in the README as the one behavior note.
- No new translation legs (e.g. Gemini) are added; the canonical-OpenAI hub keeps
  that a future inbound-only addition.
