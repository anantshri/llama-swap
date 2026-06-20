# Plan: Coalesce adjacent same-role messages in Anthropic→OpenAI conversion

## Context

llama-swap's proxy converts Anthropic `/v1/messages` requests into OpenAI
`/v1/chat/completions` requests in `internal/apiconv/anthropic_req.go`. Strict
chat templates (Mistral/Devstral/Magistral, Gemma, ...) run via `--jinja` raise a
Jinja exception — *"roles must alternate user and assistant roles except for tool
calls and results"* — when two same-role messages appear back to back. Claude
Code's resume and tool-handling flows legitimately produce consecutive
`user`/`user` (and occasionally `assistant`/`assistant`) messages, which surfaces
to the caller as an HTTP 500. Qwen3's lenient template tolerates this, which is
why "only Qwen worked" — the models were never bad at tools; the strict templates
rejected Claude Code's message shapes.

The fix belongs at this conversion layer (not in the model config), for the same
reason the existing Qwen3 system-message hoist lives here: it is model-independent
and fixes every strict template at once, while leaving `--jinja` /
Mistral `[TOOL_CALLS]` tool-calling fully intact. `tool` and `system` messages are
exempt per the templates, so only consecutive `user`/`user` and
`assistant`/`assistant` messages need merging.

Note: the `MAX_CONSECUTIVE_ERRORS` safety net mentioned in the source prompt lives
in a separate calling system (`web/engagement.py`), not this repo — out of scope here.

## Change

Single file: `internal/apiconv/anthropic_req.go`.

### 1. Add a merge pass at the end of `AnthropicToOpenAIRequest`

Insert immediately before `return json.Marshal(out)` (currently line 82). Operating
on `out.Messages` is safe: the system message (role `system`) is already prepended
and will never merge with `user`/`assistant`.

```go
// Strict chat templates (Mistral/Devstral/Magistral, Gemma, ...) raise a Jinja
// exception -- "roles must alternate user and assistant roles except for tool
// calls and results" -- when two same-role messages appear back to back. Claude
// Code's resume and tool flows produce exactly that, surfacing as an HTTP 500.
// tool/system messages are exempt per the templates, so only consecutive user
// (or assistant) messages need merging.
out.Messages = coalesceAdjacentRoles(out.Messages)

return json.Marshal(out)
```

### 2. Add three helpers (next to `simplifyParts`, which `mergeContent` reuses)

```go
func coalesceAdjacentRoles(msgs []openaiMessage) []openaiMessage {
	out := make([]openaiMessage, 0, len(msgs))
	for _, m := range msgs {
		if len(out) > 0 && (m.Role == "user" || m.Role == "assistant") && out[len(out)-1].Role == m.Role {
			prev := &out[len(out)-1]
			prev.Content = mergeContent(prev.Content, m.Content)
			prev.ToolCalls = append(prev.ToolCalls, m.ToolCalls...)
			continue
		}
		out = append(out, m)
	}
	return out
}

func mergeContent(a, b any) any {
	if as, aok := a.(string); aok {
		if bs, bok := b.(string); bok {
			switch {
			case as == "":
				return bs
			case bs == "":
				return as
			default:
				return as + "\n\n" + bs
			}
		}
	}
	parts := append(toParts(a), toParts(b)...)
	if len(parts) == 0 {
		return nil
	}
	return simplifyParts(parts)
}

func toParts(c any) []openaiContentPart {
	switch v := c.(type) {
	case string:
		if v == "" {
			return nil
		}
		return []openaiContentPart{{Type: "text", Text: v}}
	case []openaiContentPart:
		return v
	default:
		return nil
	}
}
```

## Why it is safe (verified against the current code)

- Only merges `user`/`user` and `assistant`/`assistant`. `tool` and `system` are
  never touched, so `tool_call_id` linkage and tool-call/result pairing
  (`anthropic_req.go:142-150`) are untouched.
- `openaiMessage.Content` is `any` (string or `[]openaiContentPart`); `mergeContent`
  returns the same shape. Nil cases handled: an assistant message carrying only
  `tool_calls` has nil `Content` (`flushMain`, lines 104-118) — `toParts(nil)`
  returns nil, so merging text + tool-call assistant turns yields one valid message
  with both `content` and `tool_calls`.
- Reuses existing `simplifyParts` (`anthropic_req.go:159`), so a pure-text merge
  stays a plain string (what strict templates expect), not a parts array.
- `coalesceAdjacentRoles` builds a fresh slice of value copies, so taking
  `&out[len(out)-1]` is safe.
- Text separator `\n\n` matches the existing Qwen3 hoist convention (lines 43-46).

## Critical files

- `internal/apiconv/anthropic_req.go` — the patch + 3 helpers (implementation).
- `internal/apiconv/anthropic_req_test.go` — new test (below).
- `internal/apiconv/anthropic_types.go` — reference only (no change); confirms
  `openaiMessage` shape.

## Test

Add to `internal/apiconv/anthropic_req_test.go`, mirroring the existing
`TestAnthropicToOpenAIRequest_MidConversationSystemHoisted` style (testify +
gjson). Cover:

1. **Two consecutive user messages merge into one** — assert resulting `messages`
   has a single `user` message with both texts joined by `\n\n`, and that ordering
   relative to system/assistant is preserved.
2. **Assistant text + adjacent assistant tool_call merge** — assert one assistant
   message carrying both `content` and `tool_calls`.
3. **Regression guard**: a normal `assistant(tool_calls) → tool_result → user`
   sequence is NOT merged (tool message stays separate, `tool_call_id` intact).

Example skeleton for case 1:

```go
func TestAnthropicToOpenAIRequest_ConsecutiveUserMerged(t *testing.T) {
	body := []byte(`{
		"model":"m","max_tokens":10,
		"messages":[
			{"role":"user","content":"first"},
			{"role":"user","content":"second"}
		]
	}`)
	out, err := AnthropicToOpenAIRequest(body)
	require.NoError(t, err)
	r := gjson.ParseBytes(out)

	assert.Equal(t, 1, len(r.Get("messages").Array()))
	assert.Equal(t, "user", r.Get("messages.0.role").String())
	assert.Equal(t, "first\n\nsecond", r.Get("messages.0.content").String())
}
```

## Verification

From `/workspace`:

```bash
gofmt -w internal/apiconv/anthropic_req.go internal/apiconv/anthropic_req_test.go
go test -v -run TestAnthropicToOpenAIRequest ./internal/apiconv/
make test-dev          # go test + staticcheck (internal/ changed)
make gosec             # must report zero findings (linux/darwin/windows)
make test-all          # before completing — includes long-running tests
```

Security guardrails (per AGENTS.md / CLAUDE.md), on the changed files:

```bash
semgrep scan --config auto internal/apiconv/anthropic_req.go internal/apiconv/anthropic_req_test.go
gosec ./internal/apiconv/...
```

End-to-end (optional manual confirmation): point a Devstral/Magistral model
running with `--jinja` behind llama-swap, drive a Claude Code resume/tool loop
that previously 500'd, and confirm the request now completes instead of raising
the "roles must alternate" Jinja exception.
