# Re-converge fork onto upstream, then re-port UI + API translation layer

## Context

Our fork diverged from `mostlygeek/llama-swap` by keeping the old `proxy/` package
layout while upstream rewrote everything into `internal/*` via PR #790 (new
net/http + middleware-chain routing backend). Staying on the abandoned
architecture makes every future merge harder. Instead of force-merging #790 onto
our fork (incompatible), we **re-converge**: take current upstream as the base and
re-apply our two real differentiators as clean, single-pass commits on the new
architecture:

1. The **no-npm vanilla-JS web UI** (replacing upstream's Svelte/npm UI).
2. The **API translation layer** — Anthropic Messages ↔ OpenAI (`apiconv`) and
   Ollama compatibility (`ollama`).

Outcome: a branch that is "current upstream + our UI + our translation layer," so
future upstream merges become cheap again. Historically the translation layer was
built over 3 messy commits; this is a single clean pass.

Key discovery from exploration that makes this tractable: **our UI was written
against the same `/api/*` contract upstream still exposes.** Upstream
`internal/server/apigroup.go` emits the exact SSE envelope our UI parses
(`type` ∈ `modelStatus|logData|metrics|inflight`, with stringified `data`), and
serves `/api/version`, `/api/models/unload[/{model}]`, `/api/captures/{id}`,
`/api/performance`. Upstream `internal/server/ui.go` already does compressed +
SPA-fallback static serving at `/ui/`. So the UI port is mostly a static-asset
swap, not a backend rebuild.

## Branch strategy

- `git branch upstream-code upstream/main` — pristine copy of current upstream
  (HEAD `ccfba0d`). All work below is committed **onto `upstream-code`**; diff
  against `upstream/main` (the remote ref) to see exactly our additions.
- Commit 1 = UI port. Commit 2 = API translation layer port. Each must build,
  pass tests, and pass scanners before the next.
- This is a parallel strategy to the existing `upstream-merge` branch (which holds
  the cherry-pick approach); we leave `upstream-merge` untouched.

---

## Step 1 — Create the pristine baseline branch

```
git branch upstream-code upstream/main
git switch upstream-code
```
No edits. Note: stock upstream `go build ./...` FAILS because upstream keeps a
**legacy `proxy/` implementation** (old `ProxyManager`, built by `cmd/legacy`)
whose `proxy/ui_dist` embed is npm-built/gitignored. Main binary builds via
`go build .` (uses `internal/server`). Baseline check: `go build .` green.

### Step 1b — Remove the legacy proxy implementation (decided during impl, user-approved)

Our re-converge targets the new `internal/` architecture, so the legacy `proxy/`
is redundant and re-introduces the npm/ui_dist coupling we're removing. Delete
`proxy/`, `cmd/legacy/`, `ui-svelte/`; strip the `proxy/ui_dist` placeholder
target, `ui:`/`test-ui` npm targets and `./proxy/...` from Makefile test targets;
drop `proxy/ui_dist/*` from `.gitignore`; remove legacy/npm/ui-svelte steps from
`.github/workflows/` and `.goreleaser.yaml`. Confirm `go build ./...` green
(nothing in `internal/` imports `proxy/`; only `cmd/legacy` did).

---

## Step 2 — Port the no-npm UI (Commit 1)

Upstream serves the UI from `internal/server/ui_dist/` (built from `ui-svelte/`
via `make ui` → npm). We replace the *contents* and remove the build step; the
serving code in `internal/server/ui.go` is kept as-is (it already does brotli/gzip
negotiation + SPA fallback, equivalent to our `ui_compress.go`).

**2a. Swap static assets**
- Copy our 118-file UI tree from `proxy/ui_dist/` (HEAD of `upstream-merge`) into
  `internal/server/ui_dist/`, replacing upstream's `placeholder.txt`. These are
  self-contained (vanilla ES modules + vendored marked/highlight/chart/katex);
  no transformation needed. Source via `git show upstream-merge:proxy/ui_dist/...`
  or `git checkout upstream-merge -- proxy/ui_dist` then move.
- `internal/server/ui.go` already has `//go:embed ui_dist` — no change to the
  embed directive needed. Verify it embeds our files (the `all:` prefix may be
  required because we ship `__selftest.html` with a leading underscore; if so,
  change upstream's directive to `//go:embed all:ui_dist`).

**2b. Remove the npm/Svelte build**
- Delete `ui-svelte/` entirely.
- `Makefile`: remove the `ui:` target and its `ui/node_modules` / `npm run build`
  steps; replace with the fork's note that `internal/server/ui_dist/` is
  hand-authored and committed (mirror the comment currently in our `Makefile`).
- `.gitignore`: stop ignoring `internal/server/ui_dist/*` (we now commit it).
- `.github/workflows/`: drop any node/npm UI build steps (e.g. release/containers
  jobs that run `make ui`). Grep `npm|node|ui-svelte|pnpm` under `.github/`.

**2c. Close the two backend gaps the UI needs**
- **Model-load route**: our UI's `loadModel()` calls `GET /upstream/{model}/`,
  which upstream does not have. Add a passthrough handler in `internal/server`
  (e.g. `internal/server/upstream.go`) registered as
  `mux.Handle("GET /upstream/{model}/{path...}", modelChain.Then(...))` that puts
  the path's `{model}` into the request context (reuse `router.FetchContext` /
  the context key upstream uses) and forwards to the existing dispatch
  (`s.localPeerHandler`). This triggers a load and proxies. Also add the
  `GET /upstream` → `/ui/models` redirect our UI uses.
- **Root-level icons/manifest**: our `index.html` references `/favicon.svg`,
  `/favicon-96x96.png`, `/apple-touch-icon.png`, `/site.webmanifest` at the root,
  but upstream only serves `GET /favicon.ico`. Either (preferred) add small root
  routes that serve those few files from the embedded FS, or rewrite those
  `index.html` references to `/ui/...`. Keep `GET /favicon.ico` working.
- Confirm `handleRootRedirect` (`GET /{$}`) sends to `/ui` (our UI expects `/`
  → `/ui`).

**2d. Tests**
- Port our serving tests (`proxy/ui_serve_test.go`, `proxy/ui_compress_test.go`)
  into `internal/server/`, renamed/adapted to the upstream `Server` type and
  net/http (`TestServer_ServeUIStaticFiles`, `..._ServeUISPAFallback`). Cover:
  correct MIME types for `.js/.css/.html`, SPA fallback to `index.html` for
  extension-less `/ui/*` paths, 404 for missing explicit files, root redirect.
- Confirm `internal/server/ui_compress_test.go` (upstream may already have one)
  still passes with our assets.

**Verification for Step 2**: `go build ./...`; run the binary with a minimal
config and load `http://localhost:<port>/` → redirect to `/ui` → app renders;
model list populates via SSE; load/unload buttons work; logs + performance pages
populate. `make test` green.

---

## Step 3 — Port the API translation layer (Commit 2), single clean pass

Two new pure-logic packages plus thin net/http integration in `internal/server`.
The pure translation code carries over almost unchanged; only the
`gin.ResponseWriter` wrappers and the gin handlers/wiring are rewritten to
net/http + the upstream middleware chain. **Do not add `gin` to `go.mod`** — the
port must be net/http only.

**3a. Pure logic packages (port as-is)**
- `internal/apiconv/` ← `proxy/apiconv/{apiconv.go,anthropic_req.go,anthropic_resp.go,anthropic_types.go}`
  (+ their `_test.go`). These have no gin/ProxyManager deps. Update package import
  paths only.
- `internal/ollama/` ← `proxy/ollama/{types.go,translate.go}` (+ `translate_test.go`).
  Pure translation; port as-is.

**3b. Rewrite the response-writer wrappers (gin → net/http)**
Four files wrap `gin.ResponseWriter`; rewrite each to wrap `http.ResponseWriter`,
asserting `http.Flusher` for streaming. `gin.ResponseWriter` embeds
`http.ResponseWriter`, so the logic is the same minus gin specifics:
- `internal/apiconv/buffer.go`, `internal/apiconv/anthropic_stream.go`
- `internal/ollama/buffer.go`, `internal/ollama/stream.go`
- Port the streaming tests (`anthropic_stream_test.go`, `ollama/stream_test.go`)
  using `httptest.ResponseRecorder`.

**3c. Config additions**
Add two per-model bools to `internal/config/model_config.go`:
`PassthroughAnthropic` and `PassthroughOllama` (carry semantics + YAML/JSON tags
from our fork's `proxy/config/model_config.go`). Update `config-schema.json` and
`config.example.yaml` docs. These gate whether translation is applied or the raw
body is forwarded.

**3d. Anthropic integration (insert translation on existing routes)**
Upstream already lists `/v1/messages` and `/v1/messages/count_tokens` (and `/v/`
variants) in `modelPostJSONRoutes`, mounted as `modelChain.Then(dispatch)` with
no translation. Change *only those paths* to wrap dispatch with an Anthropic
translator (new `internal/server/anthropic.go`):
- Read body; if inbound is Anthropic and the resolved model lacks
  `PassthroughAnthropic`: `apiconv.AnthropicToOpenAIRequest(body)`, set
  `r.URL.Path = "/v1/chat/completions"`, restore body with corrected length.
- Streaming (`stream:true`): wrap writer with the ported
  `AnthropicStreamWriter`, call dispatch, `Finalize()`.
- Non-streaming: wrap with the ported buffering writer, call dispatch, then
  `apiconv.OpenAIToAnthropicResponse(buf, model)` and commit.
- Implementation note: keep the existing `modelPostJSONRoutes` loop for all other
  paths; special-case the messages paths to `modelChain.Then(anthropicTranslate(dispatch))`.
  Validate ordering vs `filterMW`/`metricsMiddleware` with tests (metrics should
  see the translated OpenAI traffic).

**3e. Ollama integration (net-new routes)**
New `internal/server/ollama.go` registering, through `modelChain` (or the needed
subset) then a handler that wraps dispatch:
- Inference (translate → rewrite path → dispatch → translate back):
  `POST /api/chat`, `/api/generate` → `/v1/chat/completions`;
  `POST /api/embed`, `/api/embeddings` → `/v1/embeddings`. Honor
  `PassthroughOllama` (forward raw). Use ported `TranslateChatRequest` etc. and
  the rewritten stream/buffer writers (Ollama emits NDJSON).
- Informational/local responses: `GET /api/tags`, `POST /api/show`,
  `GET /api/ps` (build from the server's model list + running state, reusing
  `s.modelStatus()` / router state).
- Stubs: `/api/create|copy|delete|pull|push` → `501 Not Implemented`.
- Port `proxy/ollama/handlers_test.go` to net/http handler tests.

**3f. Tests** — carry over all `_test.go` from both packages, adapted to net/http;
add server-level integration tests for one Anthropic streaming, one Anthropic
buffered, one Ollama `/api/chat` streaming, and `/api/tags`.

**Verification for Step 3**:
- `go test ./internal/apiconv/... ./internal/ollama/... ./internal/server/...`
- Manual: with a fake/echo backend model, `POST /v1/messages` (stream + non-stream)
  returns Anthropic-shaped SSE/JSON; `POST /api/chat` returns Ollama NDJSON;
  `GET /api/tags` lists models. Use `cmd/fake-model` (exists upstream) as the
  backend.
- `make test-all` green; `gofmt -l .` clean.

---

## Security & docs (required before declaring done)

- `make gosec` (scans linux/darwin/windows) — fix every finding > LOW; reuse the
  repo's `// #nosec Gxxx -- reason` convention rather than restructuring. Expect to
  re-add nosec annotations on any ported code that triggers G115/G204.
- `semgrep scan --config auto` on changed dirs; `gitleaks detect --no-banner`.
- Update `README.md` fork-specific section to document the Anthropic `/v1/messages`
  translation, the Ollama `/api/*` compatibility endpoints, the
  `PassthroughAnthropic`/`PassthroughOllama` config flags, and the no-npm UI.

## Out of scope (flag, don't do here)

Other fork extras not requested in these three steps — metrics enhancements,
head-request/"enchanted" compat, peer-proxy tweaks, the `#808`/`6ea5513`
process-tree + SSE-panic fixes. Note them in `docs/upstream-merge-notes.md` as
follow-ups. (Note: upstream already provides `/v1/audio/*`, `/v1/images/*`,
`/sdapi/*`, `/v1/rerank`, so the UI playground needs no extra backend work.)

## Risks / watch-items

- **`go:embed` underscore files**: `__selftest.html` needs the `all:` embed form.
- **Asset paths**: index.html mixes `/ui/...` (fine) with root `/favicon.*` and
  `/site.webmanifest` (need root routes) — handle in 2c.
- **`modelStatus` field parity**: verify our UI reads only fields upstream's
  `apiModel` provides (id, name, description, state, unlisted, peerID, aliases);
  adapt the JS if it expects extras.
- **Middleware ordering** for the translator vs filter/metrics — pin with tests.
- **No gin**: ensure `go.mod`/`go.sum` gain no `gin-gonic` entry after the port.
