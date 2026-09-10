package config

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfig_PricingDefaults(t *testing.T) {
	yaml := `
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
`
	c, err := LoadConfigFromReader(strings.NewReader(yaml))
	require.NoError(t, err)

	assert.Equal(t, "USD", c.Pricing.Currency)
	assert.Equal(t, DefaultUSDToINR, c.Pricing.USDToINR)
	assert.Equal(t, 0.0, c.Pricing.Defaults.Input)
	assert.Equal(t, 0.0, c.Pricing.Defaults.Output)
	assert.Nil(t, c.Pricing.Defaults.Cached)
	assert.Nil(t, c.Models["m1"].Pricing)
}

func TestConfig_PricingValid(t *testing.T) {
	yaml := `
pricing:
  currency: inr
  usdToINR: 96.5
  defaults:
    input: 0.05
    output: 0.2
    cached: 0.0125
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
    pricing:
      input: 2.5
      output: 10
`
	c, err := LoadConfigFromReader(strings.NewReader(yaml))
	require.NoError(t, err)

	assert.Equal(t, "INR", c.Pricing.Currency)
	assert.Equal(t, 96.5, c.Pricing.USDToINR)
	assert.Equal(t, 0.05, c.Pricing.Defaults.Input)
	assert.Equal(t, 0.2, c.Pricing.Defaults.Output)
	require.NotNil(t, c.Pricing.Defaults.Cached)
	assert.Equal(t, 0.0125, *c.Pricing.Defaults.Cached)

	require.NotNil(t, c.Models["m1"].Pricing)
	assert.Equal(t, 2.5, c.Models["m1"].Pricing.Input)
	assert.Equal(t, 10.0, c.Models["m1"].Pricing.Output)
	assert.Nil(t, c.Models["m1"].Pricing.Cached)
}

func TestConfig_PricingInvalid(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		errPart string
	}{
		{
			name: "bad currency",
			yaml: `
pricing:
  currency: EUR
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
`,
			errPart: "pricing.currency",
		},
		{
			name: "negative usdToINR",
			yaml: `
pricing:
  usdToINR: -1
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
`,
			errPart: "pricing.usdToINR",
		},
		{
			name: "negative default input",
			yaml: `
pricing:
  defaults:
    input: -0.5
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
`,
			errPart: "pricing.defaults.input",
		},
		{
			name: "negative default cached",
			yaml: `
pricing:
  defaults:
    cached: -1
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
`,
			errPart: "pricing.defaults.cached",
		},
		{
			name: "negative model rate",
			yaml: `
models:
  "m1":
    cmd: echo
    proxy: "http://127.0.0.1:9999"
    pricing:
      output: -3
`,
			errPart: "model m1 pricing.output",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadConfigFromReader(strings.NewReader(tt.yaml))
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.errPart)
		})
	}
}
