// Token-cost estimation for the Stats page. Rates are published by the
// backend (/api/metrics/stats "pricing" key or GET /api/metrics/pricing) in
// USD per million tokens; this module resolves the effective rates for a
// model (model config > UI defaults > server defaults) and converts the
// result to the display currency.
import { formatMoney } from "./format.js";

/** First non-null numeric value among the arguments, else fallback. */
function pick(...values) {
  for (const v of values) {
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Resolve the effective USD-per-million-token rates for a model.
 *
 * Precedence: a model's own pricing block is authoritative (an omitted
 * cached rate bills cached tokens at the model's input rate). Models
 * without one use the UI default rates per field, falling through to the
 * server's pricing.defaults.
 *
 * @param {string} modelName Real model ID as stored in the activity log.
 * @param {object|null} server Server pricing snapshot: {currency, usd_to_inr,
 *   defaults, models: {modelId: {input, output, cached}}}.
 * @param {object|null} uiDefaults UI default-rates override; null fields
 *   fall through to the server defaults.
 */
export function resolveRates(modelName, server, uiDefaults) {
  const modelRates = server?.models?.[modelName];
  if (modelRates) {
    return {
      input: modelRates.input ?? 0,
      output: modelRates.output ?? 0,
      // null cached bills cached tokens at the input rate
      cached: modelRates.cached ?? null,
    };
  }
  const serverDefaults = server?.defaults ?? {};
  const src = uiDefaults ?? {};
  return {
    input: pick(src.input, serverDefaults.input, 0),
    output: pick(src.output, serverDefaults.output, 0),
    // null cached bills cached tokens at the input rate
    cached: pick(src.cached, serverDefaults.cached),
  };
}

/**
 * Estimate a model's cost in USD from a stats row.
 * Cached tokens are a subset of the prompt tokens, so they are deducted from
 * the billable input and charged at the cached rate (input rate when unset).
 * Returns 0 when no rates are configured.
 *
 * @param {{input_tokens: number, output_tokens: number, cached_tokens: number}} row
 * @param {{input: number, output: number, cached: number|null}} rates
 */
export function estimateCostUSD(row, rates) {
  const cachedRate = rates.cached == null ? rates.input : rates.cached;
  const billableInput = Math.max(0, (row.input_tokens || 0) - (row.cached_tokens || 0));
  const cost =
    (billableInput * rates.input +
      (row.cached_tokens || 0) * cachedRate +
      (row.output_tokens || 0) * rates.output) /
    1e6;
  return cost;
}

/** USD -> display currency conversion (rates are dollar-denominated). */
export function toDisplayCurrency(usd, currency, usdToInr) {
  return currency === "INR" ? usd * usdToInr : usd;
}

/** Currency symbol for the effective display currency. */
export function currencySymbol(currency) {
  return currency === "INR" ? "₹" : "$";
}

/**
 * Format an estimated cost for display, applying the currency conversion and
 * adaptive precision. Returns "—" when nothing is billable or configured.
 */
export function formatCost(usd, currency, usdToInr) {
  return formatMoney(toDisplayCurrency(usd, currency, usdToInr), currencySymbol(currency));
}
