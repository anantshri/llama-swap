// Shared display formatters used across the UI. Ported from lib/format.ts.

/** Format a millisecond duration as a human-readable string. */
export function formatDuration(ms, opts = {}) {
  const { precision = 2, subSecondMs = false } = opts;
  if (subSecondMs && ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(precision)}s`;
}

/** Format a tokens-per-second value; negative values are reported as "unknown". */
export function formatSpeed(speed) {
  return speed < 0 ? "unknown" : speed.toFixed(2) + " t/s";
}

/** Format a byte count as B / KB / MB. */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Format a hardware capacity using binary units through TiB. */
export function formatCapacity(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Not detected";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = unit < 2 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

/** Format a timestamp as a local "YYYY-MM-DD HH:mm:ss" string. */
export function formatAbsoluteTime(timestamp) {
  const date = new Date(timestamp);
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return `${datePart} ${timePart}`;
}

/** Format a timestamp as a relative time or local timestamp when older than a day. */
export function formatRelativeTime(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffInSeconds < 5) return "now";
  if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  return formatAbsoluteTime(timestamp);
}

const fullNumberFormat = new Intl.NumberFormat();

/** Render a scaled value with up to three significant digits (1.23M, 12.3M, 123M). */
function scaledNumber(value) {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits);
}

/**
 * Format a large number compactly using M/B/T suffixes; smaller values fall
 * back to the full locale-formatted number.
 */
export function formatCompactNumber(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return scaledNumber(n / 1e12) + "T";
  if (abs >= 1e9) return scaledNumber(n / 1e9) + "B";
  if (abs >= 1e6) return scaledNumber(n / 1e6) + "M";
  return fullNumberFormat.format(n);
}

/**
 * Format an approximate currency amount with adaptive precision:
 * two decimals at $0.01 and above, up to four decimals below that, and a
 * "<0.0001" floor for negligible amounts. Zero or missing values are unknown.
 * The "~" prefix signals that the value is an estimate.
 */
export function formatMoney(amount, symbol = "$") {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return "—";
  let body;
  if (amount >= 0.01) body = amount.toFixed(2);
  else if (amount >= 0.0001) body = amount.toFixed(4);
  else body = `<0.0001`;
  return `~${symbol}${body}`;
}
