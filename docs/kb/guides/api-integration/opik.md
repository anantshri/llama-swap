---
title: Using Opik with llama-swap
summary: Point Opik's Playground, Online Evaluation and LLM-as-judge metrics at llama-swap's OpenAI-compatible /v1 endpoint.
category: guides
tags: [opik, evaluation, observability, openai, integration]
config_keys: [apiKeys, hooks.on_startup.preload]
updated: 2026-10-12
---

# Using Opik with llama-swap

[Opik](https://github.com/comet-ml/opik) is an open-source LLM observability and
evaluation platform: tracing, datasets, experiments and LLM-as-a-judge metrics.
It never talks to llama-server directly — every Opik feature that needs a model
calls an OpenAI-compatible `/v1` endpoint, which is exactly what llama-swap
serves. No code changes on either side; the two integration points below are
just configuration.

## Requirements

- llama-swap running with at least one model configured.
- An Opik instance: self-hosted (`git clone` + `./opik.sh`, UI on
  `http://localhost:5173`) or Opik Cloud.
- If your config sets `apiKeys`, keep the key handy — Opik asks for it in both
  setups below. See `guides/api-integration/api-keys-and-auth`.

## Playground and Online Evaluation (AI Providers)

Opik's UI calls models server-side through configured **AI Providers**, used by
the Prompt Playground and by Online Evaluation rules (LLM-as-judge scoring on
traces).

In Opik: **Workspace Settings → AI Providers → Add configuration → "vLLM /
Custom provider"**, then:

| field | value |
| --- | --- |
| Provider name | anything, e.g. `llama-swap` |
| URL | `http://172.17.0.1:8080/v1` (Linux) — see below |
| API key | your llama-swap `apiKeys` value, or blank if none |
| Models | your llama-swap model ids, e.g. `qwen3,devstral` |

Use **Test connection**, then **Discover models** — discovery calls
llama-swap's `/v1/models`, so it lists exactly what the proxy serves
(`guides/model-runtime/capabilities-and-model-listings`).

**The URL must end in `/v1`, and `localhost` will not work.** Self-hosted Opik
runs in Docker, so from its containers your host is
`http://172.17.0.1:<port>/v1` on Linux or `http://host.docker.internal:<port>/v1`
on macOS/Windows. A `localhost` URL points at the Opik container itself and
every call fails with connection refused.

## LLM-as-judge metrics (Python SDK)

Opik's `opik` Python package uses LiteLLM for its judge metrics; LiteLLM's
`openai/` provider prefix plus two environment variables points it at
llama-swap:

```python
import os
from opik.evaluation.metrics import Hallucination

os.environ["OPENAI_API_KEY"] = "sk-your-llama-swap-key"   # any value if no apiKeys
os.environ["OPENAI_BASE_URL"] = "http://localhost:8080/v1"

metric = Hallucination(model="openai/qwen3")   # openai/<llama-swap model id>
score = metric.score(
    input="What is the capital of France?",
    output="Paris.",
    context=["Paris is the capital of France."],
)
```

The same `OPENAI_BASE_URL` works for the plain OpenAI client in the app you are
tracing — one endpoint serves both your application and its judges.

## Notes

- **Cold starts look like slow judges.** The first Playground run or judge call
  may sit in llama-swap's load queue while the model swaps in (watch the Activity
  page). Preload the judge model with `hooks.on_startup.preload` if that matters
  (`guides/operations/startup-preloading-and-hooks`).
- **Model ids must match.** What you list in the provider config or pass as
  `openai/<id>` is dispatched by llama-swap's model resolution, aliases included.
- **No CORS setup needed.** Both integration paths are server-to-server; Opik's
  browser UI never calls llama-swap directly.

## Related

- `guides/api-integration/api-keys-and-auth` — protecting the endpoint
- `guides/model-runtime/capabilities-and-model-listings` — what `/v1/models` returns
- `guides/operations/startup-preloading-and-hooks` — keeping the judge model warm
