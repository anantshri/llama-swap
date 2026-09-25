// Model picker combobox, reimplemented from components/playground/
// ModelSelector.svelte (upstream #1153) for the vanilla UI. Renders Local
// models + aliases + peer groups in a searchable dropdown: typing filters in
// real time, keyboard navigates, and models matching the tab's `match`
// predicate sort to the top. Hidden when no models are available.
import { el, cleanupAll } from "../dom.js";
import { models } from "../api.js";
import { buildModelOptions, filterModelOptions } from "../util/modelUtils.js";

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ModelSelector({ value, placeholder = "Select a model...", disabled = false, match = null }) {
  const root = el(`<div class="pg-model-combo"></div>`);
  // Typing filters the open list; cleared whenever the list opens, so opening
  // on an already selected model shows everything again.
  let open = false;
  let query = "";
  let highlight = 0;
  let visible = [];
  let isUpdatingFromState = false;

  const input = el(`<input class="pg-model-select pg-model-input" data-input type="text" autocomplete="off" spellcheck="false" />`);
  const panel = el(`<div class="pg-model-panel" data-panel style="display:none"></div>`);
  root.append(input, panel);

  function computeVisible() {
    visible = filterModelOptions(buildModelOptions(models.get()), query, match);
    if (highlight >= visible.length) highlight = Math.max(0, visible.length - 1);
  }

  function syncInput() {
    isUpdatingFromState = true;
    input.value = open ? query : value.get();
    input.placeholder = open && value.get() ? value.get() : placeholder;
    isUpdatingFromState = false;
  }

  function renderPanel() {
    computeVisible();
    const hasModels = visible.length > 0 || buildModelOptions(models.get()).length > 0;
    root.style.display = hasModels ? "" : "none";
    if (!hasModels) {
      panel.innerHTML = "";
      return;
    }
    if (!open) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    panel.style.display = "";
    const parts = [];
    let lastGroup = null;
    visible.forEach((o, i) => {
      if (o.group !== lastGroup) {
        lastGroup = o.group;
        parts.push(`<div class="pg-model-group">${escapeText(o.group)}</div>`);
      }
      const selected = o.value === value.get();
      const fits = match ? !!match(o.model, o.value) : false;
      const label = o.aliasOf ? `↳ ${escapeText(o.value)}` : escapeText(o.value);
      parts.push(
        `<button type="button" class="pg-model-option${i === highlight ? " hl" : ""}${selected ? " sel" : ""}${o.aliasOf ? " alias" : ""}" data-i="${i}">` +
          `<span class="pg-model-option-value">${label}</span>` +
          `${selected ? `<span class="pg-model-option-check">✓</span>` : ""}` +
          `${fits && !selected ? `<span class="pg-model-option-fit" title="matches this tab">◆</span>` : ""}` +
          `</button>`
      );
    });
    panel.innerHTML = parts.join("") || `<div class="pg-model-empty">No models match</div>`;
  }

  function render() {
    syncInput();
    renderPanel();
    input.disabled = !!disabled;
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    if (open) {
      query = "";
      highlight = 0;
      renderPanel();
      syncInput();
      input.select();
    } else {
      renderPanel();
      syncInput();
    }
  }

  function select(option) {
    value.set(option.value);
    setOpen(false);
  }

  input.addEventListener("focus", () => setOpen(true));
  input.addEventListener("input", () => {
    query = input.value;
    open = true;
    highlight = 0;
    renderPanel();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      highlight = Math.min(Math.max(highlight + delta, 0), Math.max(visible.length - 1, 0));
      renderPanel();
      panel.querySelector(`[data-i="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = visible[highlight];
      if (open && option) select(option);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  });
  panel.addEventListener("pointerdown", (e) => {
    // Pointerdown rather than click: the input's blur must not close the
    // panel before the button's click fires.
    const btn = e.target.closest("[data-i]");
    if (!btn) return;
    e.preventDefault();
    const option = visible[Number(btn.getAttribute("data-i"))];
    if (option) select(option);
  });
  document.addEventListener("pointerdown", (e) => {
    if (open && !root.contains(e.target)) setOpen(false);
  });

  input.addEventListener("change", () => {
    // Typing alone never changes the selection; put the state back.
    if (!isUpdatingFromState) syncInput();
  });

  const subs = [
    models.subscribe(render),
    value.subscribe(() => {
      if (!open) render();
    }),
  ];

  render();

  return {
    el: root,
    setDisabled(d) {
      disabled = d;
      input.disabled = !!d;
    },
    destroy() {
      cleanupAll(subs);
    },
  };
}
