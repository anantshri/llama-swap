# Enable Enchanted macOS client against llama-swap's Ollama API

## Context

[Enchanted](https://github.com/gluonfield/enchanted) is a SwiftUI macOS/iOS Ollama client. We want it to work against llama-swap's Ollama-compatible API surface (`proxy/ollama/`) so users can point Enchanted at a llama-swap instance instead of a real Ollama server. We investigated what API calls Enchanted actually makes versus what llama-swap proxies, and identified a single concrete gap that blocks the integration.

## Investigation summary

Enchanted was cloned to `/tmp/enchanted`. Its Ollama dependency is the `AugustDev/OllamaKit` Swift package (pinned to commit `0079411b4568dbc821c9e2589345d3f9b9538af4` in `Enchanted.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`). The library was cloned to `/tmp/ollamakit` and inspected at the pinned commit.

### What OllamaKit exposes (`/tmp/ollamakit/Sources/OllamaKit/Utils/OKRouter.swift`)

| Library method | HTTP method | Path |
|---|---|---|
| `reachable()` | HEAD | `/` |
| `models()` | GET | `/api/tags` |
| `modelInfo(...)` | POST | `/api/show` |
| `generate(...)` | POST | `/api/generate` |
| `chat(data:)` | POST | `/api/chat` |
| `copyModel(...)` | POST | `/api/copy` |
| `deleteModel(...)` | DELETE | `/api/delete` |
| `generateEmbeddings(...)` | POST | `/api/embeddings` |

Auth header: every request includes `Authorization: Bearer <ollamaBearerToken>` (`OKRouter.swift:66-71`).

### Which of those Enchanted actually calls

A grep of `OllamaService` / `ollamaKit` usage across `Enchanted/**/*.swift` finds only three call sites:

| Enchanted call site | OllamaKit method | Effective wire call |
|---|---|---|
| `Services/OllamaService.swift:50` (`reachable()`) | `reachable()` | HEAD `/` |
| `Services/OllamaService.swift:38` (`getModels()`) | `models()` | GET `/api/tags` |
| `Stores/ConversationStore.swift:171`, `UI/macOS/PromptPanel/PanelCompletionsVM.swift:55` | `chat(data:)` | POST `/api/chat` |

`reachable()` is invoked from three places:
- `Stores/AppStore.swift:44` — 5-second timer (configurable via `pingInterval` UserDefault) drives the menu-bar / status indicator.
- `UI/Shared/Settings/Settings.swift:52` — when the user edits the Ollama URI.
- `Stores/ConversationStore.swift:166` and `UI/macOS/PromptPanel/PanelCompletionsVM.swift:54` — gates every chat send; on failure, surfaces `"Server unreachable"`.

The other five OllamaKit endpoints (`generate`, `show`, `copy`, `delete`, `embeddings`) have no Enchanted call sites.

### What llama-swap proxies today

From `proxy/ollama/handlers.go:66-99` (registered under whatever group the caller mounts) and `proxy/proxymanager.go:340-461` (engine-level routes):

| Endpoint | Status |
|---|---|
| POST `/api/chat` | translated → `/v1/chat/completions` |
| POST `/api/generate` | translated → `/v1/chat/completions` |
| POST `/api/embed` | translated → `/v1/embeddings` |
| POST `/api/embeddings` | translated → `/v1/embeddings` |
| GET `/api/tags` | synthesized locally (`makeTagsHandler`, `handlers.go:288-306`) |
| POST `/api/show` | synthesized locally |
| GET `/api/ps` | synthesized locally |
| GET `/api/version` | served by llama-swap natively |
| POST `/api/create`, `/api/copy`, `/api/pull`, `/api/push`, DELETE `/api/delete`, `/api/blobs/:digest` | 501 stubs |
| GET `/` | redirects to `/ui` (`proxymanager.go:440`) |
| **HEAD `/`** | **not registered** |

### The specific reason a minimal fix works

Two of Enchanted's three endpoints already work end-to-end:

1. **GET `/api/tags`** — OllamaKit decodes with `keyDecodingStrategy = .convertFromSnakeCase` (`JSONDecoder+Default.swift:13`). llama-swap's `TagModel` / `TagDetails` (`proxy/ollama/types.go:139-155`) emit `modified_at`, `parent_model`, etc. — all required Swift-side fields decode. `modified_at` is formatted with `time.RFC3339Nano` (`handlers.go:289`), which matches OllamaKit's ISO8601 + fractional-seconds parser.

2. **POST `/api/chat` (streaming)** — `NewChatStreamWriter` (`proxy/ollama/stream.go:171-200`) emits NDJSON frames shaped `{"model":..,"created_at":..,"message":{"role":"assistant","content":..},"done":false}\n`. OllamaKit first tries the snake-case decoder on each Alamofire chunk; if that fails (multi-line chunk) it falls back to `NDJSONStream` which uses a plain `JSONDecoder()` with no key conversion. In either path, the only non-optional fields it must populate are `model`, `message.role`, and `message.content` — all already lowercase, no key transform needed. Enchanted's `handleReceive` reads only `response.message?.content` (`ConversationStore.swift:194`).

The single blocker is **HEAD `/`**:

- OllamaKit's `reachable()` (`OllamaKit+Reachable.swift:23-33`) calls `AF.request(router.root).validate()` where `router.root` resolves to method=`.head`, path=`/` (`OKRouter.swift:26,47`).
- Alamofire's default `validate()` checks status `200..<300`; content-type is gated by the `Accept` header, which OllamaKit doesn't set, so it defaults to `*/*` and accepts any body (or no body).
- llama-swap registers only `GET /` (`proxymanager.go:440`). The engine is built with `gin.New()` (`proxymanager.go:191`), which leaves `HandleMethodNotAllowed=false`. Gin's tree does not auto-map HEAD onto GET routes, so HEAD `/` returns 404 — Alamofire's `validate()` fails, `reachable()` returns `false`, and Enchanted shows "Server unreachable" everywhere.
- Because Alamofire only validates the status code, a bare 200 with no body is sufficient — no Content-Type, no payload required.

## The fix

### File to modify

- `proxy/proxymanager.go` — add a HEAD `/` handler alongside the existing GET `/` (around line 440).

### Change

Insert a HEAD handler that returns 200 with no body:

```go
pm.ginEngine.HEAD("/", func(c *gin.Context) {
    c.Status(http.StatusOK)
})
```

Place it immediately after the existing `pm.ginEngine.GET("/", ...)` registration at `proxymanager.go:440-442`.

No other files need to change. No new package, no new helper. The handler intentionally lives at the engine level (not inside `proxy/ollama/RegisterRoutes`) because:
- `reachable()` hits the bare server root, not a path under any group.
- The existing `GET /` is already engine-level, so the HEAD pair sits next to it.
- No middleware (api-key auth, inflight tracking) should apply: a reachability probe must succeed before the user has entered their bearer token.

### Why not other approaches considered and rejected

- *Set `pm.ginEngine.HandleMethodNotAllowed = true`*: returns 405 for HEAD `/`, which still fails Alamofire's `200..<300` validation.
- *Register HEAD inside `proxy/ollama/RegisterRoutes`*: the Ollama group is mounted on the engine but `reachable()` targets `/`, not `/api/...`; mixing the root-level probe into the Ollama package muddies ownership.
- *Implementing the unused endpoints (`/api/show`, `/api/copy`, etc.)*: Enchanted does not call them, so this is unneeded scope.

## Verification

1. Build: `make build` (or `go build ./...`).
2. Unit/static checks: `make test-dev` (runs `go test` + `staticcheck` over `proxy/`).
3. Manual end-to-end probe with the server running locally:
   - `curl -i -X HEAD http://localhost:<port>/` → expect `HTTP/1.1 200 OK`.
   - `curl -s http://localhost:<port>/api/tags | jq '.models[0]'` → expect a model entry with `name`, `model`, `modified_at`, `details.format == "gguf"`.
4. Enchanted smoke test:
   - In Enchanted ▸ Settings, set "Ollama server URI" to the llama-swap URL (no trailing slash).
   - If llama-swap has an API key configured, paste it into the "Bearer Token" field.
   - Confirm the reachability indicator turns green and the model list populates.
   - Start a chat and confirm streaming tokens render.
5. Regression: `make test-all` before declaring done (per `AGENTS.md`).

## Out of scope

- Implementing the OllamaKit endpoints Enchanted does not exercise (`/api/show`, `/api/copy`, `/api/delete`, `/api/generate`, `/api/embeddings`). They remain as they are (synthesized or 501).
- Auth UX in Enchanted (bearer token must be set manually by the user when llama-swap requires one).
