package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// uiServeTestProxy builds a minimal ProxyManager for exercising the static UI
// serving routes (/ui/*) and the SPA fallback.
func uiServeTestProxy(t *testing.T) *ProxyManager {
	t.Helper()
	cfg := testConfigFromYAML(t, `
healthCheckTimeout: 15
logLevel: error
models:
  model1:
    cmd: {{RESPONDER}} --port ${PORT} --silent --respond model1
`)
	pm := New(cfg)
	t.Cleanup(func() { pm.StopProcesses(StopImmediately) })
	return pm
}

// TestProxyManager_ServeUIStaticFiles verifies the hand-authored, build-free UI
// tree embedded under ui_dist is served with sane content types — guarding the
// native-ES-module + vendored-asset contract.
func TestProxyManager_ServeUIStaticFiles(t *testing.T) {
	pm := uiServeTestProxy(t)

	cases := []struct {
		path        string
		wantCTPart  string
		description string
	}{
		{"/ui/", "text/html", "index.html via directory path"},
		{"/ui/index.html", "text/html", "index.html explicit"},
		{"/ui/js/main.js", "javascript", "ES module entry"},
		{"/ui/js/store.js", "javascript", "ES module import target"},
		{"/ui/js/markdown.js", "javascript", "chat markdown renderer"},
		{"/ui/js/api/chat.js", "javascript", "chat streaming client"},
		{"/ui/js/components/chatMessage.js", "javascript", "chat message component"},
		{"/ui/vendor/marked.min.js", "javascript", "vendored library"},
		{"/ui/css/app.css", "text/css", "hand-written stylesheet"},
		{"/ui/css/chat.css", "text/css", "chat/prose stylesheet"},
		{"/ui/__selftest.html", "text/html", "in-browser self-test page"},
	}

	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			w := CreateTestResponseRecorder()
			pm.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("%s: expected 200, got %d", tc.description, w.Code)
			}
			ct := w.Header().Get("Content-Type")
			if !strings.Contains(ct, tc.wantCTPart) {
				t.Errorf("%s: Content-Type %q should contain %q", tc.description, ct, tc.wantCTPart)
			}
			if w.Body.Len() == 0 {
				t.Errorf("%s: empty body", tc.description)
			}
		})
	}
}

// TestProxyManager_ServeUISPAFallback verifies the NoRoute SPA fallback and the
// root redirect. The UI uses hash-based client routing (#/models), so deep path
// requests under /ui/ are real file lookups (404 when absent) — only /ui-prefixed
// paths that miss the /ui/*filepath route fall back to index.html.
func TestProxyManager_ServeUISPAFallback(t *testing.T) {
	pm := uiServeTestProxy(t)

	t.Run("root redirects to /ui", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := CreateTestResponseRecorder()
		pm.ServeHTTP(w, req)

		if w.Code != http.StatusFound {
			t.Fatalf("expected 302, got %d", w.Code)
		}
		if loc := w.Header().Get("Location"); loc != "/ui" {
			t.Errorf("expected redirect to /ui, got %q", loc)
		}
	})

	t.Run("noroute /ui-prefixed path serves index.html", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/uixyz", nil)
		w := CreateTestResponseRecorder()
		pm.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		if !strings.Contains(w.Header().Get("Content-Type"), "text/html") {
			t.Errorf("expected html content type, got %q", w.Header().Get("Content-Type"))
		}
		if !strings.Contains(w.Body.String(), `id="app"`) {
			t.Errorf("expected index.html body")
		}
	})

	t.Run("missing file 404s", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/ui/js/does-not-exist.js", nil)
		w := CreateTestResponseRecorder()
		pm.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for missing file, got %d", w.Code)
		}
	})
}
