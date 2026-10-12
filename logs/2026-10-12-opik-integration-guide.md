# 2026-10-12 — Opik integration evaluation + KB guide (docs-only)

## Symptom / goal

User request (verbatim, two parts):

1. *"evaluate if we can add support for https://github.com/comet-ml/opik in our
   system. or can llama-swap itself give me functionalities like opik. is that
   too big of a ask or something we are already capable off."*
2. After seeing the options, user picked **"Docs/config only"** — document how
   to run Opik against llama-swap as its OpenAI backend, zero code change.
3. *"Document in a log file as much details as we can"* — this file is that
   instruction: a full record of the evaluation, the research, and the change.

## Diagnosis / evaluation

### What Opik is

Researched from the comet-ml/opik GitHub README and docs
(https://www.comet.com/docs/opik/llms.txt index, local_deployment,
evaluation/metrics/custom_model, administration/workspace-settings/ai_providers):

- Open-source (Apache-2.0) **LLM observability & evaluation platform** by
  Comet: ~7.5k commits, Python/Java backend + ClickHouse/Postgres/Redis/MySQL +
  React frontend + Python/TS SDKs + OpenTelemetry ingestion + MCP server.
- Feature set: agent trace trees, datasets & experiments, LLM-as-a-judge
  metrics (Hallucination, Moderation, AnswerRelevance, RAG metrics), prompt
  library/versioning, prompt playground, agent optimizer, guardrails, online
  evaluation rules on production traces, dashboards (40M traces/day scale),
  CI/CD (PyTest) integration.

### What llama-swap already has (architecture survey)

Explored the whole tree (subagent pass). Findings relevant to the question:

| Opik capability | llama-swap today |
| --- | --- |
| LLM call tracing | `MetricsMiddleware` buffers full request+response (incl. every SSE chunk) per request — `internal/server/metrics_middleware.go`, tee writer in `internal/server/metrics.go:603-682` |
| Token/latency accounting | per-request input/output/cache tokens, TTFT, tok/s, error status → SQLite `activity` table; P50/P95/P99 + histograms per model (`internal/store/`) |
| Cost monitoring | `pricing` config + estimated cost in Stats UI |
| Request inspection | in-memory captures (zstd+CBOR) with redaction, pin-to-SQLite; Activity table + capture dialog in the UI; `ui.activity.session_id` grouping key |
| Event stream | typed event bus (`internal/event/`) → SSE `/api/events` |
| Eval harness | `evals/docs-agent/` — but for the UI Help chatbot only, not user traffic |

Gaps that would matter for Opik parity: no durable prompt/response retention
policy, no trace/span model (no request IDs / parent-child linking), no
datasets/experiments/judge, no OTLP or webhook export, per-request Prometheus
metrics absent.

### Verdict presented to the user

- **Reimplementing Opik inside llama-swap: too big / wrong scope.** It's a
  second product; llama-swap's identity is a light transparent proxy.
- **Native light observability slice** (durable log, replay, A/B compare,
  heuristic scores): feasible, moderate effort — not chosen this session.
- **OTLP/trace export to Opik**: feasible (clean new middleware in the
  config-composed chain at `internal/server/server.go:315-324`), ~1–2 weeks —
  not chosen this session.
- **Interop, docs-only (chosen):** Opik's model-facing features all speak the
  OpenAI-compatible HTTP API, which llama-swap serves at `/v1`. Two
  configuration-only integration points:

  1. **Opik AI Providers** — Workspace Settings → AI Providers →
     *"vLLM / Custom provider"* (docs list it for "any other OpenAI
     API-compliant provider"): URL must end in `/v1`, optional static API key
     (or OAuth2 client credentials), manual model list or **Discover models**
     which fetches `/v1/models`. Powers the **Prompt Playground** and
     **Online Evaluation** rules (LLM-as-judge scoring of traces).
  2. **Python SDK judge metrics** — Opik's `opik.evaluation.metrics` use
     LiteLLM under the hood; the `openai/` provider prefix + the standard
     `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables point judges
     at any OpenAI-compatible endpoint (documented in Opik's "Custom model"
     page for "OpenAI-compatible providers").

  Key operational gotcha from Opik's docs: self-hosted Opik runs in Docker, so
  `localhost` in the provider URL resolves to the Opik container — the host
  must be addressed as `http://172.17.0.1:<port>/v1` (Linux) or
  `http://host.docker.internal:<port>/v1` (macOS/Windows).

## Change

Single new KB article, no code touched:

- **`docs/kb/guides/api-integration/opik.md`** (new) — id
  `guides/api-integration/opik`, auto-indexed by `internal/docagent/kb.go`
  (no nav registration needed anywhere). Structure mirrors
  `mcp-endpoint.md`:
  - Frontmatter: `title: Using Opik with llama-swap`, one-sentence summary,
    `category: guides`, `tags: [opik, evaluation, observability, openai,
    integration]`, `config_keys: [apiKeys, hooks.on_startup.preload]`,
    `updated: 2026-10-12`.
  - Intro: what Opik is; it never talks to llama-server directly, only to an
    OpenAI-compatible `/v1` — zero code on either side.
  - Requirements: llama-swap + a model; Opik self-hosted (`./opik.sh`, UI on
    :5173) or Cloud; `apiKeys` note.
  - **Playground / Online Evaluation** section: table of the four provider
    fields (name, URL with the `/v1` suffix, API key, models); Test
    connection + Discover models (= llama-swap `/v1/models`); the Docker
    networking failure mode called out in bold with both host spellings.
  - **LLM-as-judge (Python SDK)** section: copy-pasteable Python snippet
    setting `OPENAI_API_KEY`/`OPENAI_BASE_URL` and using
    `Hallucination(model="openai/qwen3")`.
  - **Notes**: cold-start latency (first judge call may sit in the model load
    queue; preload via `hooks.on_startup.preload` in YAML =
    `hooks.on_startup.preload` in the schema); model ids must match llama-swap
    resolution incl. aliases; no CORS needed (server-to-server only).
  - **Related**: `api-keys-and-auth`, `capabilities-and-model-listings`,
    `startup-preloading-and-hooks` (all verified to exist before linking).
- **`CHANGELOG.md`** — one bullet under `[Unreleased] → Added`.
- **`DETAILED_CHANGELOG.md`** — dated `## 2026-10-12` entry (goal / research
  findings / change / verification), newest-first at the top.
- **This log** — `logs/2026-10-12-opik-integration-guide.md`.

### Diff summary

```
new file: docs/kb/guides/api-integration/opik.md   (~100 lines)
modified: CHANGELOG.md            (+6 lines, Unreleased/Added bullet)
modified: DETAILED_CHANGELOG.md   (+43 lines, new dated entry)
new file: logs/2026-10-12-opik-integration-guide.md
```

## Commands

```
# KB validation (frontmatter contract + cross-references)
go test ./internal/docagent/ -run TestKB -v

# full dev test pass (make test-dev is unavailable: `make` not installed
# in this container; Makefile shows test-dev = `go test -short ./...` +
# `staticcheck ./... || true` — first part run directly, staticcheck
# irrelevant for a docs-only change)
go test -short ./...
gofmt -l .

# security gate
aidc-scan
```

Errors hit and resolved:

1. `TestKB_FrontmatterIsValid/kb/guides/api-integration/opik.md` failed on
   first run: *config_keys entry "hooks.onStartup.preload" does not resolve in
   config-schema.json*. Root cause: an earlier architecture survey (explore
   subagent) had reported the hook key as `hooks.onStartup` — wrong. The
   actual YAML key is snake_case `hooks.on_startup` everywhere: struct tag
   `yaml:"on_startup"` (`internal/config/config.go:111`), `config.example.yaml`
   (hooks: on_startup: preload:), and `config-schema.json:802`. Fixed the
   frontmatter to `hooks.on_startup.preload`; re-run: PASS. A second defect
   from the same wrong assumption — the article *body* also said
   `hooks.onStartup.preload` — was caught by the fresh-eyes review (H1 below)
   and fixed identically.
2. Editing `DETAILED_CHANGELOG.md`, the insertion accidentally consumed the
   existing `## 2026-09-26 — UI upgrades…` heading (the oldString ended at
   that heading; the replacement omitted it). Noticed by re-reading the file;
   heading restored with a follow-up edit and verified via
   `rg -n '^## 2026-' DETAILED_CHANGELOG.md` (2026-10-12 first, 2026-09-26
   next, 31 dated entries intact).
3. `make: command not found` — documented above; ran the underlying commands
   directly.

## Verification

- `go test ./internal/docagent/ -run TestKB` — **PASS** for all 23 KB
  articles including the new one (frontmatter fields valid, both
  `config_keys` resolve, all `## Related` ids resolve).
- `go test -short ./...` — **ok** across all packages (exit 0).
- `gofmt -l .` — no output (no Go files touched anyway).
- `aidc-scan` — semgrep ok (clean), gitleaks ok (clean); other scanners
  correctly skipped (no shell/python/go/rust/node/manifest changes in scope).
- `make gosec` not run: zero Go changes; the two prior gofmt CI failures
  (`internal/server/api.go`, `internal/store/cache_test.go`) were fixed in an
  earlier session this same working tree and `gofmt -l .` confirms clean.

## Notes

- **Why docs-only:** the evaluation concluded the cost/value sweet spot is
  interop — Opik already treats any OpenAI-compatible `/v1` as a first-class
  backend ("vLLM / Custom provider", "Ollama" provider), and llama-swap
  already serves `/v1` (chat completions, models list, API-key auth). Writing
  code would add nothing to the integration.
- **Deeper integrations remain open** if wanted later (each was scoped):
  - *OTLP export middleware* — one span per proxied request (model, tokens,
    latency, TTFT) to Opik's OpenTelemetry endpoint; hooks cleanly into the
    composed middleware chain (`internal/server/server.go:315-324`); could
    honor incoming W3C `traceparent` headers for trace correlation.
  - *Native light observability* — durable request log (reuse
    `pinned_captures` machinery), replay/compare across models, heuristic
    scoring in the Activity UI.
  Rebuilding Opik's datasets/experiments/judge stack was ruled out as a
  product-scope decision, not a technical one.
- **KB writing rules followed** (`docs/kb/README.md`): one screen of text,
  copy-pasteable blocks, failure modes emphasized (Docker networking,
  cold-start, id matching), no restating of `config.example.yaml`.
- **Choice detail:** guide placed in `guides/api-integration/` because both
  integration points are clients talking to llama-swap's OpenAI API — same
  category as `api-keys-and-auth` and `mcp-endpoint.md` (used as the template).
- **`config_keys` subtlety for future KB articles:** the validator resolves
  against `config-schema.json`, which snake_cases compound keys
  (`hooks.on_startup.preload`); llama-swap's YAML config is snake_case too
  (`internal/config/config.go` yaml tags), so the schema is the single source
  of truth for both. Do not trust secondary summaries (including subagent
  reports) over the schema file.
- **Fresh-eyes review (pre-completion gate):** an independent subagent was
  given the diff, the task description, and the repo guidance. It found:
  - **H1 (fixed):** article body said `hooks.onStartup.preload` while the real
    YAML key is `hooks.on_startup.preload` — a user copying it would get a
    silently ignored key (no preloading), violating the KB "working config"
    rule. Corrected in the guide.
  - **M2 (fixed):** this log originally rationalized the H1 spelling with a
    false claim that the YAML config uses `onStartup`; rewritten to record the
    real root cause (bad data from the architecture survey).
  - **L3 (fixed):** diff-summary line counts corrected (+6/+43, not +8/+44).
  Reviewer also verified clean: frontmatter contract, config_keys resolution
  (config-schema.json:837, :802-810), all Related ids exist, ports/URLs
  consistent, test names (`golden_test.go:29`, `:130`), article/entry counts,
  and `git status` showing only the four declared files.
- Opik specifics verified against current docs (fetched 2026-10-12): provider
  dialog fields and the `172.17.0.1`/`host.docker.internal` guidance from
  `administration/workspace-settings/ai_providers.md`; `OPENAI_BASE_URL` +
  `openai/` prefix from `evaluation/metrics/custom_model.md`; `./opik.sh`
  deployment from `self-host/local_deployment.md`. If Opik renames the
  "vLLM / Custom provider" entry, only the walkthrough section needs a touch.
