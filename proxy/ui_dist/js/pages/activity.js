// Activity page — scaffold placeholder (implemented in a later phase).
import { el } from "../dom.js";

export function ActivityPage() {
  const root = el(`<div class="page page-activity"><h2>Activity</h2><p class="muted">Coming soon (build-free rewrite in progress).</p></div>`);
  return { el: root, destroy() {} };
}
