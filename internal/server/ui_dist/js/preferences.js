// Stats-page display preferences shared between the Stats page and the
// Settings page. All values persist in localStorage via the observable
// persistent() store, so changes made in Settings are picked up by the
// Stats page live through subscriptions.
import { persistent } from "./store.js";

/** Compress large token/request counts to M/B/T suffixes on the Stats page. */
export const compactNumbers = persistent("stats-compactNumbers", false);

/** Show the estimated-cost column and summary tile on the Stats page. */
export const showCost = persistent("stats-showCost", true);

/** Display currency: "" follows the server config; otherwise "USD" or "INR". */
export const currencyPref = persistent("stats-currency", "");

/**
 * USD -> INR conversion rate; 0 follows the server config. Only applies when
 * the effective display currency is INR.
 */
export const inrPerUsdPref = persistent("stats-inrPerUsd", 0);

/**
 * Default token rates ($/1M) used for models without their own config
 * pricing. A null field follows the server's pricing.defaults.
 */
export const defaultRatesPref = persistent("stats-defaultRates", {
  input: null,
  output: null,
  cached: null,
});
