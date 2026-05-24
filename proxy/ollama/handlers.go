package ollama

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ModelInfo is the slice of model metadata the ollama package needs to render
// /api/tags, /api/show, and /api/ps. It carries only what's required; the
// authoritative source is proxy/config.ModelConfig.
type ModelInfo struct {
	ID          string
	Aliases     []string
	Name        string
	Description string
	Metadata    map[string]any
}

// Dispatcher is the interface that proxy.ProxyManager (via an adapter)
// implements to satisfy the ollama handlers. Decoupling avoids an import cycle
// and keeps this package testable in isolation.
type Dispatcher interface {
	// DispatchJSON forwards the (translated, OpenAI-shaped) body to the
	// resolved model's process group. Errors are written to c via the
	// proxy's standard error responder.
	DispatchJSON(c *gin.Context, body []byte)

	// ListModels returns every non-unlisted model in the config, plus
	// aliases when the operator has enabled IncludeAliasesInList.
	ListModels() []ModelInfo

	// FindModel resolves a name (or alias) to its info.
	FindModel(name string) (ModelInfo, bool)

	// RunningModels returns the IDs of currently-loaded models (those in
	// StateReady), used to render /api/ps.
	RunningModels() []string
}

// Options controls route registration.
type Options struct {
	// Version is returned from /api/version when SkipVersion is false. Some
	// Ollama clients gate features on this string; pick a value at or above
	// the current upstream Ollama release.
	Version string

	// SkipVersion omits /api/version from registration. Set this when the
	// caller already serves a compatible /api/version handler (llama-swap's
	// native /api/version returns {"version":...} so it satisfies Ollama
	// clients out of the box).
	SkipVersion bool

	// Middlewares apply to every Ollama route. Pass the proxy's
	// apiKeyAuth and trackInflight here.
	Middlewares []gin.HandlerFunc
}

// RegisterRoutes wires the Ollama-compatible endpoints onto r.
func RegisterRoutes(r gin.IRouter, d Dispatcher, opts Options) {
	if opts.Version == "" {
		opts.Version = "0.0.0-llama-swap"
	}

	group := r.Group("")
	for _, mw := range opts.Middlewares {
		group.Use(mw)
	}

	// Inference endpoints — translated to OpenAI shape, forwarded.
	group.POST("/api/chat", makeChatHandler(d))
	group.POST("/api/generate", makeGenerateHandler(d))
	group.POST("/api/embed", makeEmbedHandler(d))
	group.POST("/api/embeddings", makeEmbeddingsHandler(d))

	// Informational endpoints — answered locally.
	group.GET("/api/tags", makeTagsHandler(d))
	group.POST("/api/show", makeShowHandler(d))
	group.GET("/api/ps", makePsHandler(d))
	if !opts.SkipVersion {
		group.GET("/api/version", makeVersionHandler(opts.Version))
	}

	// Model management — not implementable atop llama-swap.
	notImpl := notImplementedHandler("model management is not implemented; llama-swap routes requests to user-managed processes")
	group.POST("/api/create", notImpl)
	group.POST("/api/copy", notImpl)
	group.DELETE("/api/delete", notImpl)
	group.POST("/api/pull", notImpl)
	group.POST("/api/push", notImpl)
	group.HEAD("/api/blobs/:digest", notImpl)
	group.POST("/api/blobs/:digest", notImpl)
}

func writeError(c *gin.Context, status int, msg string) {
	c.JSON(status, ErrorResponse{Error: msg})
}

func notImplementedHandler(msg string) gin.HandlerFunc {
	return func(c *gin.Context) {
		writeError(c, http.StatusNotImplemented, msg)
	}
}

// --- inference handlers ---

func makeChatHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			writeError(c, http.StatusBadRequest, "could not read request body")
			return
		}
		var req ChatRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
			return
		}
		if req.Model == "" {
			writeError(c, http.StatusBadRequest, "missing 'model' field")
			return
		}

		translated, err := TranslateChatRequest(&req)
		if err != nil {
			writeError(c, http.StatusBadRequest, err.Error())
			return
		}

		// Ollama defaults stream to true when omitted.
		streaming := true
		if req.Stream != nil {
			streaming = *req.Stream
		}

		c.Request.URL.Path = "/v1/chat/completions"

		if streaming {
			runStreaming(c, d, translated, NewChatStreamWriter(c.Writer, req.Model))
		} else {
			runBuffered(c, d, translated, req.Model, "application/json", TranslateChatResponse)
		}
	}
}

func makeGenerateHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			writeError(c, http.StatusBadRequest, "could not read request body")
			return
		}
		var req GenerateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
			return
		}
		if req.Model == "" {
			writeError(c, http.StatusBadRequest, "missing 'model' field")
			return
		}

		translated, err := TranslateGenerateRequest(&req)
		if err != nil {
			writeError(c, http.StatusBadRequest, err.Error())
			return
		}

		streaming := true
		if req.Stream != nil {
			streaming = *req.Stream
		}

		c.Request.URL.Path = "/v1/chat/completions"

		if streaming {
			runStreaming(c, d, translated, NewGenerateStreamWriter(c.Writer, req.Model))
		} else {
			runBuffered(c, d, translated, req.Model, "application/json", TranslateGenerateResponse)
		}
	}
}

func makeEmbedHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			writeError(c, http.StatusBadRequest, "could not read request body")
			return
		}
		var req EmbedRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
			return
		}
		if req.Model == "" {
			writeError(c, http.StatusBadRequest, "missing 'model' field")
			return
		}
		translated, err := TranslateEmbedRequest(&req)
		if err != nil {
			writeError(c, http.StatusBadRequest, err.Error())
			return
		}
		c.Request.URL.Path = "/v1/embeddings"
		runBuffered(c, d, translated, req.Model, "application/json", TranslateEmbedResponse)
	}
}

func makeEmbeddingsHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			writeError(c, http.StatusBadRequest, "could not read request body")
			return
		}
		var req EmbeddingsRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
			return
		}
		if req.Model == "" {
			writeError(c, http.StatusBadRequest, "missing 'model' field")
			return
		}
		translated, err := TranslateEmbeddingsRequest(&req)
		if err != nil {
			writeError(c, http.StatusBadRequest, err.Error())
			return
		}
		c.Request.URL.Path = "/v1/embeddings"

		// The legacy endpoint ignores total duration; use a translator that
		// drops the model and duration parameters.
		runBuffered(c, d, translated, req.Model, "application/json",
			func(body []byte, _ string, _ time.Duration) ([]byte, error) {
				return TranslateEmbeddingsResponse(body)
			})
	}
}

// runStreaming installs sw on c.Writer, dispatches, then finalizes.
func runStreaming(c *gin.Context, d Dispatcher, body []byte, sw *StreamWriter) {
	original := c.Writer
	c.Writer = sw
	defer func() {
		sw.Finalize()
		c.Writer = original
	}()
	d.DispatchJSON(c, body)
}

// translator is the signature shared by the non-streaming response converters.
type translator func(openaiBody []byte, model string, totalDuration time.Duration) ([]byte, error)

// runBuffered installs a BufferingWriter, dispatches, then either translates
// the captured 2xx body or passes through whatever error the upstream wrote.
func runBuffered(c *gin.Context, d Dispatcher, body []byte, model, contentType string, tr translator) {
	original := c.Writer
	bw := NewBufferingWriter(original)
	c.Writer = bw
	start := time.Now()
	d.DispatchJSON(c, body)
	c.Writer = original

	status := bw.CapturedStatus()
	if status < 200 || status >= 300 {
		bw.CommitPassThrough()
		return
	}

	translated, err := tr(bw.CapturedBody(), model, time.Since(start))
	if err != nil {
		writeError(c, http.StatusBadGateway, fmt.Sprintf("error translating upstream response: %v", err))
		return
	}
	bw.CommitTranslated(translated, contentType, http.StatusOK)
}

// --- informational handlers ---

func makeTagsHandler(d Dispatcher) gin.HandlerFunc {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return func(c *gin.Context) {
		models := d.ListModels()
		resp := TagsResponse{Models: make([]TagModel, 0, len(models))}
		for _, m := range models {
			resp.Models = append(resp.Models, TagModel{
				Name:       m.ID,
				Model:      m.ID,
				ModifiedAt: now,
				Details:    TagDetails{Format: "gguf"},
			})
		}
		sort.Slice(resp.Models, func(i, j int) bool {
			return resp.Models[i].Name < resp.Models[j].Name
		})
		c.JSON(http.StatusOK, resp)
	}
}

func makeShowHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			writeError(c, http.StatusBadRequest, "could not read request body")
			return
		}
		var req struct {
			Model string `json:"model"`
			Name  string `json:"name"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(c, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
			return
		}
		name := req.Model
		if name == "" {
			name = req.Name
		}
		if name == "" {
			writeError(c, http.StatusBadRequest, "missing 'model' field")
			return
		}
		m, ok := d.FindModel(name)
		if !ok {
			writeError(c, http.StatusNotFound, fmt.Sprintf("model %q not found", name))
			return
		}
		resp := ShowResponse{
			Modelfile:  fmt.Sprintf("# Model managed by llama-swap as %q\n", m.ID),
			Parameters: "",
			Template:   "",
			Details: TagDetails{
				Format: "gguf",
			},
		}
		// Surface user-provided metadata under model_info so clients that
		// care can read it without us inventing a schema for fields llama-swap
		// doesn't track natively.
		if m.Metadata != nil {
			resp.ModelInfo = map[string]any{"llamaswap": m.Metadata}
		}
		// Best-effort capability hints from metadata; safe to omit.
		if caps := capabilitiesFromMetadata(m.Metadata); len(caps) > 0 {
			resp.Capabilities = caps
		}
		c.JSON(http.StatusOK, resp)
	}
}

func capabilitiesFromMetadata(meta map[string]any) []string {
	if meta == nil {
		return nil
	}
	out := []string{"completion"}
	if v, _ := meta["vision"].(bool); v {
		out = append(out, "vision")
	}
	if v, _ := meta["tools"].(bool); v {
		out = append(out, "tools")
	}
	if v, _ := meta["embedding"].(bool); v {
		out = append(out, "embedding")
	}
	return out
}

func makePsHandler(d Dispatcher) gin.HandlerFunc {
	return func(c *gin.Context) {
		ids := d.RunningModels()
		future := time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano)
		resp := PsResponse{Models: make([]PsModel, 0, len(ids))}
		for _, id := range ids {
			resp.Models = append(resp.Models, PsModel{
				Name:      id,
				Model:     id,
				ExpiresAt: future,
				Details:   TagDetails{Format: "gguf"},
			})
		}
		sort.Slice(resp.Models, func(i, j int) bool {
			return resp.Models[i].Name < resp.Models[j].Name
		})
		c.JSON(http.StatusOK, resp)
	}
}

func makeVersionHandler(version string) gin.HandlerFunc {
	v := strings.TrimSpace(version)
	if v == "" {
		v = "0.0.0-llama-swap"
	}
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, VersionResponse{Version: v})
	}
}
