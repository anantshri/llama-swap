# Fill in `prompt_per_second` / `tokens_per_second` when upstream omits a `timings` block

## Context

`/api/metrics` and the dashboard report `prompt_per_second: -1` and `tokens_per_second: -1` for the majority of real traffic. The diagnostic in `feature-addition.md` traced the cause to a single mechanism in `proxy/metrics_monitor.go`:

- `buildMetrics` only derives rates from an upstream-emitted `timings` block.
- Only **llama-server on `/v1/chat/completions`** emits that block. Everything else — vLLM on any route, **llama-server on `/v1/messages`** (Anthropic-format, used by Claude Code), `/v1/responses`, etc. — produces a `usage` object but no `timings`, so both rate fields fall through to `-1`.

vLLM's Prometheus `/metrics` endpoint exists but is server-wide aggregates with no per-request label, so it cannot be reliably attributed to individual proxied requests. Per-request attribution requires either (a) an in-body metrics field the upstream chooses to emit, or (b) the proxy measuring timing itself from data it already has.

**Goal:** for every request where the upstream doesn't hand us a `timings` block, compute rates from data llama-swap already observes (request start, time-of-first-byte, total duration, input/output tokens). Apply universally — no per-upstream config, no separate scraper. Treat any future in-body vLLM `metrics` object as an opportunistic best source when present.

## Approach

A four-tier fallback inside `buildMetrics`. Order of precedence (highest first):

1. **Upstream `timings` block** (existing path, llama-server `/v1/chat/completions`). Unchanged.
2. **In-body metrics object** (opportunistic — covers possible future vLLM in-body metrics, or any other upstream that emits one). Cheap check, harmless if absent.
3. **Streaming TTFT split** (proxy-observed first-byte time). Splits duration into prefill and decode; computes both rates honestly. Covers the common case — Claude Code, OpenWebUI, and most chat clients stream.
4. **Non-streaming approximation**. Only `tokens_per_second` can be approximated (`output_tokens / duration`); `prompt_per_second` stays `-1` because there's no signal to separate prefill from decode without TTFT. Documented as a known limitation rather than a misleading number.

This decision was confirmed with the user: hybrid (in-body, then approximate), applied to all upstreams, no new config field.

## Changes

### `proxy/metrics_monitor.go`

**1. Capture time-of-first-byte in `responseBodyCopier` (lines 618–649)**

Add a `firstWrite time.Time` field. Set it inside `Write()` on the first call with `len(b) > 0`. Expose with `FirstWriteTime()` accessor mirroring `StartTime()`. Leaves the type's existing semantics untouched for non-streaming responses (a single Write fires for the whole body — `firstWrite` ≈ end, which the fallback logic handles by ignoring it when it would yield a degenerate split).

**2. Thread `firstWrite` through the parse functions**

- `processStreamingResponse` (lines 479–554): add a `firstWrite time.Time` parameter; forward it to `buildMetrics`.
- `parseMetrics` (lines 556–559): same — add the parameter and forward.
- `wrapHandler` (lines 350–382): pass `recorder.FirstWriteTime()` to both call sites.

**3. Extend `buildMetrics` (lines 563–595) with the fallback chain**

New signature: `buildMetrics(modelID, start, firstWrite, inputTokens, outputTokens, cachedTokens, body, timings)`. The `body` (or just an `inBodyMetrics gjson.Result` extracted upstream) is needed so tier 2 can read it.

Logic:

```
if timings.Exists():
    # existing branch, unchanged
elif inBodyMetrics.Exists():
    # tier 2: opportunistic — try gjson paths "metrics", "vllm_metrics",
    # fields like tokens_per_second / prompt_per_second / time_to_first_token_ms.
    # Only assign rates that are positive and finite.
elif !firstWrite.IsZero() && firstWrite.After(start) && firstWrite.Before(now):
    # tier 3: streaming TTFT split
    prefillMs = (firstWrite - start).Milliseconds()
    decodeMs  = wallDurationMs - prefillMs
    if prefillMs > 0 && inputTokens > 0:
        promptPerSecond = inputTokens * 1000 / prefillMs
    if decodeMs > 0 && outputTokens > 0:
        tokensPerSecond = outputTokens * 1000 / decodeMs
else:
    # tier 4: non-streaming, no timings, no in-body metrics
    if wallDurationMs > 0 && outputTokens > 0:
        tokensPerSecond = outputTokens * 1000 / wallDurationMs
    # promptPerSecond stays -1 — honest about not knowing prefill split
```

Guard rails to keep:
- Never emit `0` or `Inf` rates — leave `-1` instead.
- Never let a tier-3 split yield a negative `decodeMs` (clamp to 0 → skip).
- Keep existing precedence: a real `timings` block always wins.

**4. Wire `inBodyMetrics` parsing**

In `wrapHandler` (line 358 branch) and `processStreamingResponse` (loop body), look for an in-body metrics object using the same gjson pattern as `usage`/`timings`. Likely paths to try: `metrics`, `vllm_metrics`. The path list lives next to `usagePaths` (line 431). Treat absent fields as "tier did not apply" rather than zero.

### Tests (`proxy/metrics_monitor_test.go` — extend, do not create new file)

Follow existing `TestMetricsMonitor_*` naming. Add focused unit tests around `buildMetrics`:

- `TestMetricsMonitor_BuildMetrics_TimingsTakesPrecedence` — when both `timings` and approximation inputs are present, timings values stick.
- `TestMetricsMonitor_BuildMetrics_StreamingTTFTSplit` — synthetic `start` + `firstWrite` + token counts → expect both rates derived from the split with the expected values (use exact arithmetic — pick numbers that produce whole results).
- `TestMetricsMonitor_BuildMetrics_NonStreamingApproximation` — `firstWrite.IsZero()`, no timings → expect `tokens_per_second` filled, `prompt_per_second == -1`.
- `TestMetricsMonitor_BuildMetrics_InBodyMetrics` — body contains a `metrics` object → those values used, fallback skipped.
- `TestMetricsMonitor_BuildMetrics_NoSignal` — no timings, no firstWrite, zero duration → both rates remain `-1`, no panic, no divide-by-zero.

## Critical files

- `proxy/metrics_monitor.go` — all production changes (~80 lines added, no deletions).
- `proxy/metrics_monitor_test.go` — extend with the five tests above.

No config schema changes. No new packages. No new dependencies.

## Out of scope (call out, do not implement here)

- **`cache_tokens: -1` vs `0` for vLLM.** Diagnostic notes vLLM doesn't return `cache_read_input_tokens`. The existing extractor at line 471 already reads `prompt_tokens_details.cached_tokens` which vLLM should populate when prefix caching is on. If a real vLLM request still shows `cache_tokens: -1`, that's worth a separate ticket; don't conflate with the rate-rendering fix.
- **Polling vLLM `/metrics`.** Rejected during scoping — per-request attribution is unreliable and the integration cost is high.
- **Per-model upstream-type config.** Rejected during scoping — the proposed fallback chain works generically.

## Verification

1. Unit tests: `go test -v -run TestMetricsMonitor_BuildMetrics ./proxy/`
2. Static + short tests: `make test-dev` clean (project rule from `AGENTS.md`).
3. Format: `gofmt -l proxy/metrics_monitor.go proxy/metrics_monitor_test.go` returns empty.
4. Full suite before completing: `make test-all`.
5. Manual smoke (no automated fixture for upstream behavior):
   - Start a vLLM model via llama-swap.
   - Issue a **streaming** `/v1/chat/completions` request and a **non-streaming** one; check `GET /api/metrics` — streaming entry should have both rates positive; non-streaming entry should have `tokens_per_second > 0` and `prompt_per_second == -1`.
   - Start a llama-server model. Hit `/v1/chat/completions` (control: timings present, both rates positive — unchanged) and `/v1/messages` (previously `-1`; now should be populated via tier 3 for streaming, tier 4 for non-streaming).
6. Confirm dashboard renders the new values (no UI changes needed — same fields, just no longer `-1`).
