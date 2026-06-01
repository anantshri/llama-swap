// Tiny DOM helpers shared across components.

// Build an element from an HTML string (single root node).
export function el(htmlStr) {
  const t = document.createElement("template");
  t.innerHTML = htmlStr.trim();
  return t.content.firstElementChild;
}

// Build a document fragment from an HTML string (multiple roots).
export function frag(htmlStr) {
  const t = document.createElement("template");
  t.innerHTML = htmlStr.trim();
  return t.content;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on(node, event, handler, opts) {
  node.addEventListener(event, handler, opts);
  return () => node.removeEventListener(event, handler, opts);
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Run a list of unsubscribe/cleanup functions, ignoring nullish entries.
export function cleanupAll(fns) {
  for (const fn of fns) {
    if (typeof fn === "function") fn();
  }
}
