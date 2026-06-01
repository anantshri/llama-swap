// Performance page — scaffold placeholder (implemented in a later phase).
import { el } from "../dom.js";

export function PerformancePage() {
  const root = el(`<div class="page page-performance"><h2>Performance</h2><p class="muted">Coming soon (build-free rewrite in progress).</p></div>`);
  return { el: root, destroy() {} };
}
