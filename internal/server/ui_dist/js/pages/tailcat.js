// Tailcat page: connection token + shareable peer config + Tailcat-sourced
// activity. Ported from ui/src/routes/Tailcat.svelte (upstream Tailcat
// series), simplified to stacked cards.
import { el, escapeHtml } from "../dom.js";
import { getTailcatStatus } from "../api.js";
import { peerConfigYaml } from "../util/tailcatPeerConfig.js";
import { ActivityTable } from "../components/activityTable.js";

const DOTS_MASK = "•".repeat(24);

export function TailcatPage() {
  const root = el(`
    <div class="page page-tailcat">
      <div class="page-heading">
        <h2 class="page-title">Tailcat</h2>
        <p class="muted page-subtitle">Private, end-to-end encrypted access without a Tailscale account.</p>
      </div>
      <div data-body><div class="card hw-loading muted">Loading Tailcat status…</div></div>
    </div>
  `);
  const bodyEl = root.querySelector("[data-body]");

  let revealed = false;
  let activityTable = null;

  // Clipboard with the LAN-HTTP fallback the rest of this UI uses
  // (navigator.clipboard is undefined on plain HTTP origins).
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  async function copy(text, btn) {
    if (await copyText(text)) {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = original), 1800);
    } else {
      btn.textContent = "Copy failed";
      setTimeout(() => (btn.textContent = "Copy"), 1800);
    }
  }

  function render(status) {
    // Reveal/Hide re-renders; the previous activity table's listeners and
    // subscriptions must not leak.
    if (activityTable) {
      activityTable.destroy();
      activityTable = null;
    }
    if (!status.enabled || !status.address) {
      bodyEl.innerHTML = `
        <div class="card tailcat-status">
          <h3 class="hw-section-title">Not enabled</h3>
          <p class="muted">Start llama-swap with <code>-listen-tailcat &lt;path/to/server.private.json&gt;</code>
          and a <code>tailcat:</code> config block to expose models privately. See the
          <a class="models-link" href="https://github.com/mostlygeek/llama-swap/blob/main/docs/kb/guides/operations/tailcat.md" target="_blank" rel="noopener">Tailcat guide</a>.</p>
        </div>`;
      return;
    }
    const models = status.models ?? [];
    const configYaml = models.length > 0 ? peerConfigYaml(status.address, models) : "";
    bodyEl.innerHTML = `
      <div class="card tailcat-status">
        <div class="hw-summary-head">
          <h3 class="hw-section-title">Connection token</h3>
          <div class="tailcat-actions">
            <button class="btn btn--sm" data-reveal>${revealed ? "Hide" : "Reveal"}</button>
            <button class="btn btn--sm" data-copy-token>Copy</button>
          </div>
        </div>
        <p class="muted">Treat this case-sensitive token like a capability: anyone holding it can attempt to connect.</p>
        <code class="tailcat-token" data-token>${revealed ? escapeHtml(status.address) : DOTS_MASK}</code>
      </div>
      <div class="card tailcat-status">
        <div class="hw-summary-head">
          <h3 class="hw-section-title">Peer config</h3>
          ${models.length > 0 ? `<button class="btn btn--sm" data-copy-config>Copy</button>` : ""}
        </div>
        ${
          models.length === 0
            ? `<p class="muted">This Tailcat listener isn't exposing any models yet, so there's nothing to share.</p>`
            : `<p class="muted">A ready-to-paste <code>peers</code> entry for a friend to add to their own config so they can route requests through this server.</p>
               <textarea class="hw-summary-text tailcat-config" readonly rows="8" data-config>${escapeHtml(configYaml)}</textarea>`
        }
      </div>
      <div class="card tailcat-activity">
        <div class="hw-summary-head">
          <h3 class="hw-section-title">Requests via Tailcat</h3>
          <span class="muted">${models.length} ${models.length === 1 ? "model" : "models"} exposed</span>
        </div>
        <div data-activity></div>
      </div>`;

    bodyEl.querySelector("[data-reveal]")?.addEventListener("click", () => {
      revealed = !revealed;
      render(status);
    });
    bodyEl.querySelector("[data-copy-token]")?.addEventListener("click", (e) => copy(status.address, e.target));
    bodyEl.querySelector("[data-copy-config]")?.addEventListener("click", (e) => copy(configYaml, e.target));

    const activityHost = bodyEl.querySelector("[data-activity]");
    activityTable = ActivityTable({
      srcPrefix: "tc:",
      storagePrefix: "tailcat-activity",
      emptyMessage: "No Tailcat-sourced requests yet",
    });
    activityHost.appendChild(activityTable.el);
  }

  (async () => {
    try {
      render(await getTailcatStatus());
    } catch (cause) {
      bodyEl.innerHTML = `
        <div class="card hw-error">
          <h3 class="hw-error-title">Tailcat status unavailable</h3>
          <p class="muted">${escapeHtml(cause instanceof Error ? cause.message : "unknown error")}</p>
        </div>`;
    }
  })();

  return {
    el: root,
    destroy() {
      if (activityTable) activityTable.destroy();
    },
  };
}
