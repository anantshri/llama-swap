// Package apiconv translates LLM API requests and responses between the
// OpenAI, Anthropic, and Ollama wire formats. The OpenAI chat-completions
// shape is used as the canonical intermediate representation: incoming
// requests are converted to OpenAI before dispatch, and upstream OpenAI
// responses are converted back to the client's format.
//
// The currently implemented leg is Anthropic client -> OpenAI backend
// (request + response, streaming and buffered). Other legs are no-ops that
// fall back to raw pass-through.
package apiconv

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// Format identifies an LLM API wire format.
type Format string

const (
	FormatOpenAI    Format = "openai"
	FormatAnthropic Format = "anthropic"
	FormatOllama    Format = "ollama"
)

// ParseFormat normalizes a config backendApi string into a Format. Unknown
// values fall back to FormatOpenAI (config validation rejects them earlier).
func ParseFormat(s string) Format {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case string(FormatAnthropic):
		return FormatAnthropic
	case string(FormatOllama):
		return FormatOllama
	default:
		return FormatOpenAI
	}
}

// CanTranslate reports whether a converter exists for the given client format
// (in) talking to the given backend format (out). When in == out no translation
// is needed and the request is passed through unchanged.
func CanTranslate(in, out Format) bool {
	if in == out {
		return false
	}
	// Implemented: Anthropic client -> OpenAI backend.
	return in == FormatAnthropic && out == FormatOpenAI
}

// BackendChatPath returns the canonical chat endpoint path for a backend format.
func BackendChatPath(out Format) string {
	switch out {
	case FormatAnthropic:
		return "/v1/messages"
	case FormatOllama:
		return "/api/chat"
	default:
		return "/v1/chat/completions"
	}
}

// ConvertRequest converts a request body from client format in to backend
// format out. Unsupported pairs return the body unchanged.
func ConvertRequest(in, out Format, body []byte) ([]byte, error) {
	if in == FormatAnthropic && out == FormatOpenAI {
		return AnthropicToOpenAIRequest(body)
	}
	return body, nil
}

// ConvertBufferedResponse converts a buffered upstream response (in backend
// format out) back to the client format in. model is the client-requested
// model name, echoed into the response.
func ConvertBufferedResponse(in, out Format, body []byte, model string) ([]byte, error) {
	if in == FormatAnthropic && out == FormatOpenAI {
		return OpenAIToAnthropicResponse(body, model)
	}
	return body, nil
}

// StreamTranslator is a response writer that converts a streaming upstream
// response into the client's format. Finalize emits any trailing framing.
type StreamTranslator interface {
	gin.ResponseWriter
	Finalize()
}

// NewStreamTranslator returns a StreamTranslator that converts a streaming
// backend response (format out) back to the client format in, or nil if the
// pair is unsupported.
func NewStreamTranslator(in, out Format, w gin.ResponseWriter, model string) StreamTranslator {
	if in == FormatAnthropic && out == FormatOpenAI {
		return NewAnthropicStreamWriter(w, model)
	}
	return nil
}
