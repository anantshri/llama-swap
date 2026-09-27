// Model picker combobox, reimplemented from components/playground/
// ModelSelector.svelte (upstream #1153) for the vanilla UI. Renders Local
// models + aliases + peer groups in a searchable dropdown: typing filters in
// real time, keyboard navigates, and models matching the tab's `match`
// predicate sort to the top. Hidden when no models are available.
//
// When a `match` predicate is given (image/audio/speech/rerank tabs), the
// list shows only models that fit the tab by default — a text-generation
// model is useless in the Images tab. A footer toggle reveals every model
// for the rare cases the capability tags are wrong or missing.
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
  // Tabs with capability needs start filtered to fitting models; the footer
  // toggle flips this per picker instance.
  let fitsOnly = !!match;

  const input = el(`<input class="pg-model-select pg-model-input" data-input type="text" autocomplete="off" spellcheck="false" />`);
  const panel = el(`<div class="pg-model-panel" data-panel style="display:none"></div>`);
  root.append(input, panel);

  function computeVisible() {
    visible = filterModelOptions(buildModelOptions(models.get()), query, match);
    if (fitsOnly && match) visible = visible.filter((o) => match(o.model, o.value));
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
    if (!parts.length) {
      const total = buildModelOptions(models.get()).length;
      parts.push(`<div class="pg-model-empty">${fitsOnly && total > 0 ? "No models fit this tab" : "No models match"}</div>`);
    }
    // Footer toggle between fitting models and the full list; only shown
    // when it can change something.
    if (match) {
      const total = buildModelOptions(models.get()).length;
      const fits = buildModelOptions(models.get()).filter((o) => match(o.model, o.value)).length;
      if (fitsOnly ? fits < total : true) {
        parts.push(
          `<button type="button" class="pg-model-all" data-cap-toggle>` +
            `${fitsOnly ? `Show all models (${total - fits} hidden)` : "Show fitting models only"}</button>`
        );
      }
    }
    panel.innerHTML = parts.join("");
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
  panel.addEventListener("click", (e) => {
    const t = e.target.closest("[data-cap-toggle]");
    if (!t) return;
    fitsOnly = !fitsOnly;
    highlight = 0;
    renderPanel();
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
