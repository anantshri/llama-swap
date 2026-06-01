// Logs page — scaffold placeholder (implemented in a later phase).
import { el } from "../dom.js";

export function LogsPage() {
  const root = el(`<div class="page page-logs"><h2>Logs</h2><p class="muted">Coming soon (build-free rewrite in progress).</p></div>`);
  return { el: root, destroy() {} };
}
