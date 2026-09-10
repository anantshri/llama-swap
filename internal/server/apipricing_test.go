package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mostlygeek/llama-swap/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServer_APIMetricsPricing(t *testing.T) {
	s := newTestServer(newStubRouter(nil, ""), newStubRouter(nil, ""))
	cachedDefault := 0.0125
	s.cfg.Pricing = config.PricingConfig{
		Currency: "INR",
		USDToINR: 96.5,
		Defaults: config.PricingRates{Input: 0.05, Output: 0.2, Cached: &cachedDefault},
	}
	s.cfg.Models = map[string]config.ModelConfig{
		"m1": {Pricing: &config.PricingRates{Input: 2.5, Output: 10}},
		"m2": {},
	}

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/metrics/pricing", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var pricing APIPricing
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &pricing))
	assert.Equal(t, "INR", pricing.Currency)
	assert.Equal(t, 96.5, pricing.USDToINR)
	assert.Equal(t, 0.05, pricing.Defaults.Input)
	require.NotNil(t, pricing.Defaults.Cached)
	assert.Equal(t, 0.0125, *pricing.Defaults.Cached)

	// only models with a pricing block are listed; m1's unset cached stays nil
	require.Len(t, pricing.Models, 1)
	m1, ok := pricing.Models["m1"]
	require.True(t, ok)
	assert.Equal(t, 2.5, m1.Input)
	assert.Equal(t, 10.0, m1.Output)
	assert.Nil(t, m1.Cached)
}

func TestServer_APIMetricsStats_IncludesPricing(t *testing.T) {
	s := newTestServer(newStubRouter(nil, ""), newStubRouter(nil, ""))
	s.cfg.Pricing = config.PricingConfig{Currency: "USD", USDToINR: 95}
	s.cfg.Models = map[string]config.ModelConfig{
		"m1": {Pricing: &config.PricingRates{Input: 1, Output: 2}},
	}

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/metrics/stats", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var raw struct {
		TotalRequests int        `json:"total_requests"`
		Pricing       APIPricing `json:"pricing"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &raw))
	assert.Equal(t, 0, raw.TotalRequests)
	assert.Equal(t, "USD", raw.Pricing.Currency)
	assert.Equal(t, 95.0, raw.Pricing.USDToINR)
	assert.NotNil(t, raw.Pricing.Models["m1"])
}

func TestServer_APIMetricsPricing_DefaultsWhenUnconfigured(t *testing.T) {
	s := newTestServer(newStubRouter(nil, ""), newStubRouter(nil, ""))

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/metrics/pricing", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var pricing APIPricing
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &pricing))
	assert.Equal(t, "USD", pricing.Currency)
	assert.Equal(t, config.DefaultUSDToINR, pricing.USDToINR)
	assert.NotNil(t, pricing.Models)
	assert.Empty(t, pricing.Models)
}
