package server

import (
	"context"
	"net/http"
	"slices"

	"github.com/mostlygeek/llama-swap/internal/config"
	"github.com/mostlygeek/llama-swap/internal/swaputil"
	"github.com/mostlygeek/llama-swap/internal/tailcat"
)

// ServeTailcatHTTP applies Tailcat's deliberately narrow HTTP capability
// surface before delegating to the normal, API-key-protected handler.
// (Ported from upstream's server.go with the tailcat series, #1074–#1169.)
func (s *Server) ServeTailcatHTTP(w http.ResponseWriter, r *http.Request) {
	tc := s.cfg.Tailcat
	if !s.cfg.TailcatEnabled() || tc == nil {
		http.NotFound(w, r)
		return
	}
	// tailcat.allow is enforced per request rather than by the Tailcat
	// listener so config reloads can change it without restarting the
	// listener, and so removed keys lose access on kept-alive connections.
	if !tailcatClientAllowed(tc.Allow, r) {
		http.Error(w, "Tailcat client not allowed", http.StatusForbidden)
		return
	}

	inference := isTailcatInferenceRequest(r)
	if !tc.Admin {
		allowed := r.Method == http.MethodGet && (r.URL.Path == "/health" || r.URL.Path == "/v1/models" || r.URL.Path == "/models")
		if r.Method == http.MethodOptions {
			allowed = isTailcatInferencePath(r.URL.Path)
		}
		if inference {
			allowed = true
		}
		if !allowed {
			http.NotFound(w, r)
			return
		}
	}

	if inference && r.Method != http.MethodOptions {
		// Normalize first so the model lookup sees the same body format the
		// model chain will.
		if bodyErr := prepareModelBody(w, r); bodyErr != nil {
			http.NotFound(w, r)
			return
		}
		model, err := swaputil.ExtractModel(r)
		if err != nil || !tailcatModelAllowed(tc.Models, model) {
			http.NotFound(w, r)
			return
		}
	}
	r = r.WithContext(context.WithValue(r.Context(), tailcatRequestContextKey{}, true))
	s.handler.ServeHTTP(w, r)
}

// tailcatClientAllowed reports whether the request's authenticated Tailcat
// node key is in allow. Access is denied by default: an empty allow list
// permits no client, and "*" permits every client.
func tailcatClientAllowed(allow []string, r *http.Request) bool {
	if slices.Contains(allow, config.TailcatAllowAll) {
		return true
	}
	nodeKey, ok := tailcat.NodeKeyFromContext(r.Context())
	return ok && slices.Contains(allow, nodeKey)
}

func isTailcatInferenceRequest(r *http.Request) bool {
	if r.Method == http.MethodPost {
		for _, path := range modelPostJSONRoutes {
			if r.URL.Path == path {
				return true
			}
		}
		for _, path := range modelPostFormRoutes {
			if r.URL.Path == path {
				return true
			}
		}
	}
	if r.Method == http.MethodGet {
		for _, path := range modelGetRoutes {
			if r.URL.Path == path {
				return true
			}
		}
	}
	return false
}

func isTailcatInferencePath(path string) bool {
	for _, candidate := range modelPostJSONRoutes {
		if path == candidate {
			return true
		}
	}
	for _, candidate := range modelPostFormRoutes {
		if path == candidate {
			return true
		}
	}
	for _, candidate := range modelGetRoutes {
		if path == candidate {
			return true
		}
	}
	return false
}

func tailcatModelAllowed(models []string, id string) bool {
	for _, exposed := range models {
		if exposed == "*" || exposed == id {
			return true
		}
	}
	return false
}
