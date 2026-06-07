package server

import (
	"testing"
	"time"

	"github.com/tidwall/gjson"
)

func TestServer_ParseMetrics_ChatCompletions(t *testing.T) {
	body := `{"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}`
	parsed := gjson.Parse(body)
	entry, err := parseMetrics("m", time.Now(), parsed.Get("usage"), parsed.Get("timings"), parsed.Get("metrics"))
	if err != nil {
		t.Fatalf("parseMetrics: %v", err)
	}
	if entry.Tokens.InputTokens != 12 || entry.Tokens.OutputTokens != 7 || entry.Tokens.CachedTokens != 4 {
		t.Fatalf("tokens = %+v", entry.Tokens)
	}
}

func TestServer_ParseMetrics_Timings(t *testing.T) {
	body := `{"timings":{"prompt_n":20,"predicted_n":50,"prompt_per_second":100.0,"predicted_per_second":40.0,"prompt_ms":200,"predicted_ms":1250,"cache_n":8}}`
	parsed := gjson.Parse(body)
	entry, err := parseMetrics("m", time.Now(), parsed.Get("usage"), parsed.Get("timings"), parsed.Get("metrics"))
	if err != nil {
		t.Fatalf("parseMetrics: %v", err)
	}
	if entry.Tokens.InputTokens != 20 || entry.Tokens.OutputTokens != 50 || entry.Tokens.CachedTokens != 8 {
		t.Fatalf("tokens = %+v", entry.Tokens)
	}
	if entry.Tokens.TokensPerSecond != 40.0 || entry.Tokens.PromptPerSecond != 100.0 {
		t.Fatalf("rates = %+v", entry.Tokens)
	}
	if entry.DurationMs != 1450 {
		t.Fatalf("DurationMs = %d, want 1450", entry.DurationMs)
	}
}

func TestServer_ProcessStreamingResponse(t *testing.T) {
	body := []byte("data: {\"choices\":[{}]}\n\n" +
		"data: {\"usage\":{\"prompt_tokens\":15,\"completion_tokens\":33}}\n\n" +
		"data: [DONE]\n\n")
	entry, err := processStreamingResponse("m", time.Now(), time.Time{}, body)
	if err != nil {
		t.Fatalf("processStreamingResponse: %v", err)
	}
	if entry.Tokens.InputTokens != 15 || entry.Tokens.OutputTokens != 33 {
		t.Fatalf("tokens = %+v", entry.Tokens)
	}
}

func TestServer_ProcessStreamingResponse_NoData(t *testing.T) {
	if _, err := processStreamingResponse("m", time.Now(), time.Time{}, []byte("data: [DONE]\n\n")); err == nil {
		t.Fatal("expected error for stream with no usage data")
	}
}

func TestServer_ParseMetrics_Infill(t *testing.T) {
	// /infill responses are arrays; timings live in the last element.
	body := `[{"content":"a"},{"content":"b","timings":{"prompt_n":5,"predicted_n":9,"prompt_ms":10,"predicted_ms":20}}]`
	parsed := gjson.Parse(body)
	timings := parsed.Get("timings")
	if arr := parsed.Array(); len(arr) > 0 {
		timings = arr[len(arr)-1].Get("timings")
	}
	entry, err := parseMetrics("m", time.Now(), parsed.Get("usage"), timings, parsed.Get("metrics"))
	if err != nil {
		t.Fatalf("parseMetrics: %v", err)
	}
	if entry.Tokens.InputTokens != 5 || entry.Tokens.OutputTokens != 9 {
		t.Fatalf("tokens = %+v", entry.Tokens)
	}
}

// TestServer_BuildMetrics_TimingsTakesPrecedence verifies the upstream timings
// block wins even when a streaming TTFT signal (firstWrite) is also present.
func TestServer_BuildMetrics_TimingsTakesPrecedence(t *testing.T) {
	timings := gjson.Parse(`{"prompt_n":20,"predicted_n":50,"prompt_per_second":100.0,"predicted_per_second":40.0,"prompt_ms":200,"predicted_ms":1250}`)
	start := time.Now().Add(-time.Second)
	firstWrite := start.Add(200 * time.Millisecond)

	entry := buildMetrics("m", start, firstWrite, 1, 1, -1, timings, gjson.Result{})

	if entry.Tokens.PromptPerSecond != 100.0 || entry.Tokens.TokensPerSecond != 40.0 {
		t.Fatalf("rates = %+v, want timings values 100/40", entry.Tokens)
	}
	if entry.Tokens.InputTokens != 20 || entry.Tokens.OutputTokens != 50 {
		t.Fatalf("tokens = %+v, want timings counts 20/50", entry.Tokens)
	}
}

// TestServer_BuildMetrics_InBodyMetrics verifies an in-body metrics object is
// used when present and no timings block is available.
func TestServer_BuildMetrics_InBodyMetrics(t *testing.T) {
	inBody := gjson.Parse(`{"prompt_per_second":250.0,"tokens_per_second":75.0}`)
	start := time.Now().Add(-time.Second)

	entry := buildMetrics("m", start, time.Time{}, 30, 60, -1, gjson.Result{}, inBody)

	if entry.Tokens.PromptPerSecond != 250.0 || entry.Tokens.TokensPerSecond != 75.0 {
		t.Fatalf("rates = %+v, want in-body values 250/75", entry.Tokens)
	}
}

// TestServer_BuildMetrics_StreamingTTFTSplit verifies that, with no timings or
// in-body metrics, a streaming firstWrite splits the duration into prefill and
// decode. prompt_per_second is exact (prefill = firstWrite-start is controlled);
// tokens_per_second is only asserted positive since wall duration depends on now.
func TestServer_BuildMetrics_StreamingTTFTSplit(t *testing.T) {
	start := time.Now().Add(-time.Second)
	firstWrite := start.Add(200 * time.Millisecond) // prefill = 200ms

	entry := buildMetrics("m", start, firstWrite, 20, 80, -1, gjson.Result{}, gjson.Result{})

	if entry.Tokens.PromptPerSecond != 100.0 { // 20 tokens / 0.2s
		t.Fatalf("PromptPerSecond = %v, want 100", entry.Tokens.PromptPerSecond)
	}
	if entry.Tokens.TokensPerSecond <= 0 {
		t.Fatalf("TokensPerSecond = %v, want > 0", entry.Tokens.TokensPerSecond)
	}
}

// TestServer_BuildMetrics_NonStreamingApproximation verifies the non-streaming
// tier fills tokens_per_second from output/duration but leaves prompt_per_second
// at -1 because there is no signal to separate prefill from decode.
func TestServer_BuildMetrics_NonStreamingApproximation(t *testing.T) {
	start := time.Now().Add(-time.Second)

	entry := buildMetrics("m", start, time.Time{}, 30, 60, -1, gjson.Result{}, gjson.Result{})

	if entry.Tokens.PromptPerSecond != -1 {
		t.Fatalf("PromptPerSecond = %v, want -1", entry.Tokens.PromptPerSecond)
	}
	if entry.Tokens.TokensPerSecond <= 0 {
		t.Fatalf("TokensPerSecond = %v, want > 0", entry.Tokens.TokensPerSecond)
	}
}

// TestServer_BuildMetrics_NoSignal verifies that with no timings, no in-body
// metrics, no firstWrite and no output tokens, both rates stay at the -1
// "unknown" sentinel without panicking or dividing by zero.
func TestServer_BuildMetrics_NoSignal(t *testing.T) {
	entry := buildMetrics("m", time.Now(), time.Time{}, 0, 0, -1, gjson.Result{}, gjson.Result{})

	if entry.Tokens.PromptPerSecond != -1 || entry.Tokens.TokensPerSecond != -1 {
		t.Fatalf("rates = %+v, want both -1", entry.Tokens)
	}
}
