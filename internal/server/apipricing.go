package server

import (
	"encoding/json"
	"net/http"

	"github.com/mostlygeek/llama-swap/internal/config"
)

// APIPricingRates publishes per-million-token prices. Rates are denominated
// in USD; the UI converts them when displaying another currency. Cached is
// nil when unset, meaning cached tokens bill at the input rate.
type APIPricingRates struct {
	Input  float64  `json:"input"`
	Output float64  `json:"output"`
	Cached *float64 `json:"cached"`
}

// APIPricing describes the server's pricing configuration: the configured
// display currency, the USD -> INR conversion rate, default rates for models
// without their own pricing, and per-model overrides. The UI may override any
// of these locally through its settings page.
type APIPricing struct {
	Currency string                     `json:"currency"`
	USDToINR float64                    `json:"usd_to_inr"`
	Defaults APIPricingRates            `json:"defaults"`
	Models   map[string]APIPricingRates `json:"models"`
}

func apiPricingRates(r config.PricingRates) APIPricingRates {
	return APIPricingRates{Input: r.Input, Output: r.Output, Cached: r.Cached}
}

// apiPricing builds the pricing snapshot from the server's config. cfg is
// immutable for the lifetime of a Server instance (hot reloads create a new
// Server), so no locking is required. Values fall back to the documented
// defaults so consumers never see a blank currency or a zero rate.
func (s *Server) apiPricing() APIPricing {
	currency := s.cfg.Pricing.Currency
	if currency == "" {
		currency = "USD"
	}
	usdToINR := s.cfg.Pricing.USDToINR
	if usdToINR <= 0 {
		usdToINR = config.DefaultUSDToINR
	}
	out := APIPricing{
		Currency: currency,
		USDToINR: usdToINR,
		Defaults: apiPricingRates(s.cfg.Pricing.Defaults),
		Models:   make(map[string]APIPricingRates, len(s.cfg.Models)),
	}
	for id, mc := range s.cfg.Models {
		if mc.Pricing != nil {
			out.Models[id] = apiPricingRates(*mc.Pricing)
		}
	}
	return out
}

// handleAPIMetricsPricing serves the pricing snapshot so lightweight clients
// (like the settings page) can show configured rates without fetching stats.
func (s *Server) handleAPIMetricsPricing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.apiPricing())
}
