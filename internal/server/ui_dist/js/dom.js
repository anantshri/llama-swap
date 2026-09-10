// Tiny DOM helpers shared across components.

// Build an element from an HTML string (single root node).
//
// The node is adopted into the live document before returning. A <template>'s
// .content belongs to a separate inert document whose defaultView is null, so a
// detached node created here would have no associated window. Libraries that read
// layout at construction time (e.g. Chart.js calling
// canvas.ownerDocument.defaultView.getComputedStyle) crash on such nodes when used
// before the node is appended. Adopting up front gives the node the real window.
export function el(htmlStr) {
  const t = document.createElement("template");
  t.innerHTML = htmlStr.trim();
  const node = t.content.firstElementChild;
  return node ? document.adoptNode(node) : node;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Copy text to the clipboard, falling back to a hidden textarea + execCommand
// outside secure contexts. Returns whether the copy succeeded.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    return true;
  } catch (e) {
    console.error("copy failed", e);
    return false;
  }
}

// Trigger a browser download for a blob/data URL and filename.
export function triggerDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Playground stage blocks: working spinner and error panel. The per-interface
// message class (e.g. "pg-audio-msg") carries the CSS specifics.
export const pgSpinner = (msgClass, msg) => `
  <div class="${msgClass}">
    <div class="spinner"></div>
    <p>${escapeHtml(msg)}</p>
  </div>`;

export const pgError = (msgClass, msg) => `
  <div class="${msgClass} pg-error">
    <p class="pg-error-title">Error</p>
    <p class="pg-error-body">${escapeHtml(msg)}</p>
  </div>`;

// Auto-scroll a message list to its bottom unless the user has scrolled up
// (following resumes when reset() is called, e.g. on send).
export function stickToBottom(el) {
  let userScrolledUp = false;
  el.addEventListener("scroll", () => {
    const { scrollTop, scrollHeight, clientHeight } = el;
    userScrolledUp = scrollHeight - scrollTop - clientHeight > 40;
  });
  return {
    reset: () => (userScrolledUp = false),
    maybe(instant) {
      if (userScrolledUp) return;
      el.scrollTo({ top: el.scrollHeight, behavior: instant ? "instant" : "smooth" });
    },
  };
}

// Run a list of unsubscribe/cleanup functions, ignoring nullish entries.
export function cleanupAll(fns) {
  for (const fn of fns) {
    if (typeof fn === "function") fn();
  }
}
