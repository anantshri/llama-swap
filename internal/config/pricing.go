package config

import (
	"fmt"
	"strings"
)

// DefaultUSDToINR is the USD -> INR conversion rate used when
// pricing.usdToINR is not configured.
const DefaultUSDToINR = 95.0

// PricingRates holds approximate token prices in US dollars per million
// tokens. Cached is optional: a nil value bills cached tokens at the input
// rate.
type PricingRates struct {
	Input  float64  `yaml:"input"`
	Output float64  `yaml:"output"`
	Cached *float64 `yaml:"cached"`
}

// PricingConfig is the top-level `pricing:` configuration section. It defines
// the display currency, the USD -> INR conversion rate, and default token
// prices applied to models that do not define their own pricing.
type PricingConfig struct {
	// Currency selects the display currency: USD (default) or INR.
	Currency string `yaml:"currency"`

	// USDToINR converts dollar-denominated prices when Currency is INR.
	USDToINR float64 `yaml:"usdToINR"`

	// Defaults apply to models without their own pricing block.
	Defaults PricingRates `yaml:"defaults"`
}

func (r PricingRates) Validate(what string) error {
	if r.Input < 0 {
		return fmt.Errorf("%s.input: must be >= 0, got %g", what, r.Input)
	}
	if r.Output < 0 {
		return fmt.Errorf("%s.output: must be >= 0, got %g", what, r.Output)
	}
	if r.Cached != nil && *r.Cached < 0 {
		return fmt.Errorf("%s.cached: must be >= 0, got %g", what, *r.Cached)
	}
	return nil
}

// Validate normalizes and validates the pricing configuration.
func (p *PricingConfig) Validate() error {
	p.Currency = strings.ToUpper(strings.TrimSpace(p.Currency))
	switch p.Currency {
	case "":
		p.Currency = "USD"
	case "USD", "INR":
	default:
		return fmt.Errorf("pricing.currency: invalid currency %q (valid: USD, INR)", p.Currency)
	}
	if p.USDToINR == 0 {
		p.USDToINR = DefaultUSDToINR
	}
	if p.USDToINR < 0 {
		return fmt.Errorf("pricing.usdToINR: must be > 0, got %g", p.USDToINR)
	}
	return p.Defaults.Validate("pricing.defaults")
}
