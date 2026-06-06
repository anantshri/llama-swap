package apiconv

import (
	"encoding/json"
	"fmt"
)

// AnthropicToOpenAIRequest converts an Anthropic /v1/messages request body into
// an OpenAI /v1/chat/completions request body.
func AnthropicToOpenAIRequest(body []byte) ([]byte, error) {
	var req anthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("invalid anthropic request: %w", err)
	}

	out := openaiRequest{
		Model:       req.Model,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stop:        req.StopSequences,
		Stream:      req.Stream,
	}
	if req.MaxTokens > 0 {
		mt := req.MaxTokens
		out.MaxTokens = &mt
	}
	if req.Stream {
		out.StreamOptions = &streamOptions{IncludeUsage: true}
	}

	// System content -> a single leading system message. Besides the top-level
	// system field, Anthropic allows "mid-conversation system messages"
	// (role:"system" entries inside messages[], a feature Claude Code uses since
	// v2.1.154). Many OpenAI-compatible backends reject a system message that is
	// not first -- e.g. the strict Qwen3 chat template raises "System message
	// must be at the beginning" -- so hoist every system block, in order, into
	// one leading system message.
	systemText := decodeAnthropicText(req.System)
	appendSystem := func(s string) {
		if s == "" {
			return
		}
		if systemText != "" {
			systemText += "\n\n"
		}
		systemText += s
	}

	var rest []openaiMessage
	for _, m := range req.Messages {
		if m.Role == "system" {
			appendSystem(decodeAnthropicText(m.Content))
			continue
		}
		msgs, err := convertAnthropicMessage(m)
		if err != nil {
			return nil, err
		}
		rest = append(rest, msgs...)
	}

	if systemText != "" {
		out.Messages = append(out.Messages, openaiMessage{Role: "system", Content: systemText})
	}
	out.Messages = append(out.Messages, rest...)

	// Tools.
	for _, t := range req.Tools {
		out.Tools = append(out.Tools, openaiTool{
			Type: "function",
			Function: openaiToolFunction{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.InputSchema,
			},
		})
	}
	if tc := convertToolChoice(req.ToolChoice); tc != nil {
		out.ToolChoice = tc
	}

	return json.Marshal(out)
}

// convertAnthropicMessage converts one Anthropic message into one or more
// OpenAI messages. A user message containing tool_result blocks expands into
// separate role:"tool" messages.
func convertAnthropicMessage(m anthropicMessage) ([]openaiMessage, error) {
	// Content may be a plain string.
	var asString string
	if err := json.Unmarshal(m.Content, &asString); err == nil {
		return []openaiMessage{{Role: m.Role, Content: asString}}, nil
	}

	var blocks []anthropicBlock
	if err := json.Unmarshal(m.Content, &blocks); err != nil {
		return nil, fmt.Errorf("invalid message content for role %q: %w", m.Role, err)
	}

	var out []openaiMessage
	var parts []openaiContentPart
	var toolCalls []openaiToolCall

	flushMain := func() {
		if len(parts) == 0 && len(toolCalls) == 0 {
			return
		}
		msg := openaiMessage{Role: m.Role}
		if len(parts) > 0 {
			msg.Content = simplifyParts(parts)
		}
		if len(toolCalls) > 0 {
			msg.ToolCalls = toolCalls
		}
		out = append(out, msg)
		parts = nil
		toolCalls = nil
	}

	for _, b := range blocks {
		switch b.Type {
		case "text":
			parts = append(parts, openaiContentPart{Type: "text", Text: b.Text})
		case "image":
			if b.Source != nil {
				url := fmt.Sprintf("data:%s;base64,%s", b.Source.MediaType, b.Source.Data)
				parts = append(parts, openaiContentPart{Type: "image_url", ImageURL: &openaiImageURL{URL: url}})
			}
		case "tool_use":
			args := string(b.Input)
			if args == "" {
				args = "{}"
			}
			toolCalls = append(toolCalls, openaiToolCall{
				ID:   b.ID,
				Type: "function",
				Function: openaiToolCallFunc{
					Name:      b.Name,
					Arguments: args,
				},
			})
		case "tool_result":
			// tool_result lives in a user message but maps to a role:"tool"
			// message in OpenAI; flush any pending content first to preserve order.
			flushMain()
			out = append(out, openaiMessage{
				Role:       "tool",
				ToolCallID: b.ToolUseID,
				Content:    decodeAnthropicText(b.Content),
			})
		}
	}
	flushMain()
	return out, nil
}

// simplifyParts collapses a parts slice that is purely text into a single
// string (the common case), otherwise returns the parts slice unchanged.
func simplifyParts(parts []openaiContentPart) any {
	allText := true
	for _, p := range parts {
		if p.Type != "text" {
			allText = false
			break
		}
	}
	if allText {
		var s string
		for _, p := range parts {
			s += p.Text
		}
		return s
	}
	return parts
}

// decodeAnthropicText extracts plain text from a value that is either a JSON
// string or an array of Anthropic content blocks (concatenating text blocks).
func decodeAnthropicText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []anthropicBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var out string
		for _, b := range blocks {
			if b.Type == "text" {
				out += b.Text
			}
		}
		return out
	}
	return ""
}

// convertToolChoice maps an Anthropic tool_choice to the OpenAI equivalent.
func convertToolChoice(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var tc struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &tc); err != nil {
		return nil
	}
	switch tc.Type {
	case "auto":
		return json.RawMessage(`"auto"`)
	case "any":
		return json.RawMessage(`"required"`)
	case "tool":
		b, err := json.Marshal(map[string]any{
			"type":     "function",
			"function": map[string]string{"name": tc.Name},
		})
		if err != nil {
			return nil
		}
		return b
	default:
		return nil
	}
}
