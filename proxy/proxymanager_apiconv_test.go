package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

// setProcessHandlers installs a custom upstream handler on every process,
// bypassing subprocess launch (like injectTestHandlers but with a caller-supplied
// handler so the response shape can be controlled).
func setProcessHandlers(pm *ProxyManager, h http.Handler) {
	for _, pg := range pm.processGroups {
		for _, process := range pg.processes {
			process.testHandler = h
		}
	}
}

// TestProxyManager_AnthropicToOpenAI exercises the /v1/messages -> /v1/chat/completions
// translation for a model whose backend speaks OpenAI (the default).
func TestProxyManager_AnthropicToOpenAI_Buffered(t *testing.T) {
	testConfig := testConfigFromYAML(t, `
logLevel: error
models:
  m1:
    cmd: {{RESPONDER}} --port ${PORT} --silent --respond m1
`)
	proxy := New(testConfig)
	defer proxy.StopProcesses(StopImmediately)

	var gotPath string
	var gotBody []byte
	setProcessHandlers(proxy, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"chatcmpl-1","choices":[{"index":0,"message":{"role":"assistant","content":"hi from openai"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`))
	}))

	reqBody := `{"model":"m1","max_tokens":50,"messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString(reqBody))
	w := CreateTestResponseRecorder()
	proxy.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// Request was translated to OpenAI shape and forwarded to the chat endpoint.
	assert.Equal(t, "/v1/chat/completions", gotPath)
	upstream := gjson.ParseBytes(gotBody)
	assert.Equal(t, "user", upstream.Get("messages.0.role").String())
	assert.Equal(t, "hello", upstream.Get("messages.0.content").String())
	assert.Equal(t, int64(50), upstream.Get("max_tokens").Int())

	// Response was translated back to Anthropic shape.
	resp := gjson.ParseBytes(w.Body.Bytes())
	assert.Equal(t, "message", resp.Get("type").String())
	assert.Equal(t, "m1", resp.Get("model").String())
	assert.Equal(t, "hi from openai", resp.Get("content.0.text").String())
	assert.Equal(t, "end_turn", resp.Get("stop_reason").String())
	assert.Equal(t, int64(3), resp.Get("usage.input_tokens").Int())
	assert.Equal(t, int64(2), resp.Get("usage.output_tokens").Int())
}

func TestProxyManager_AnthropicToOpenAI_Streaming(t *testing.T) {
	testConfig := testConfigFromYAML(t, `
logLevel: error
models:
  m1:
    cmd: {{RESPONDER}} --port ${PORT} --silent --respond m1
`)
	proxy := New(testConfig)
	defer proxy.StopProcesses(StopImmediately)

	var gotStreamParam string
	setProcessHandlers(proxy, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotStreamParam = gjson.GetBytes(body, "stream").Raw
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		fmt.Fprint(w, `data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}`+"\n\n")
		flusher.Flush()
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}`+"\n\n")
		flusher.Flush()
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))

	reqBody := `{"model":"m1","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString(reqBody))
	w := CreateTestResponseRecorder()
	proxy.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "true", gotStreamParam, "upstream should receive stream:true")

	body := w.Body.String()
	assert.Contains(t, body, "event: message_start")
	assert.Contains(t, body, "event: content_block_delta")
	assert.Contains(t, body, "event: message_stop")

	// Reconstruct streamed text from text_delta events.
	var text string
	for _, frame := range strings.Split(body, "\n\n") {
		for _, line := range strings.Split(frame, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				d := gjson.Parse(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				if d.Get("delta.type").String() == "text_delta" {
					text += d.Get("delta.text").String()
				}
			}
		}
	}
	assert.Equal(t, "Hello world", text)
}

// TestProxyManager_AnthropicBackendPassthrough verifies that when the backend
// speaks Anthropic, /v1/messages is forwarded raw (no translation).
func TestProxyManager_AnthropicBackendPassthrough(t *testing.T) {
	testConfig := testConfigFromYAML(t, `
logLevel: error
models:
  m1:
    cmd: {{RESPONDER}} --port ${PORT} --silent --respond m1
    passthroughAnthropic: true
`)
	proxy := New(testConfig)
	defer proxy.StopProcesses(StopImmediately)

	var gotPath string
	var gotBody []byte
	setProcessHandlers(proxy, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"type":"message","content":[{"type":"text","text":"native"}]}`))
	}))

	reqBody := `{"model":"m1","max_tokens":50,"messages":[{"role":"user","content":"hello"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString(reqBody))
	w := CreateTestResponseRecorder()
	proxy.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	// No translation: path and body forwarded unchanged, response passed through.
	assert.Equal(t, "/v1/messages", gotPath)
	assert.Equal(t, reqBody, string(gotBody))
	assert.Contains(t, w.Body.String(), `"native"`)
}
