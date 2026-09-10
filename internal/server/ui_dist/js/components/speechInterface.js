// TTS interface: model + voice selector, persistent autoplay, audio player.
// Ported from components/playground/SpeechInterface.svelte.
import { el, cleanupAll, escapeHtml, pgSpinner, pgError, triggerDownload } from "../dom.js";
import { fetchOk, subscribeHasModels } from "../api.js";
import { playgroundStores, runTask } from "../playgroundActivity.js";
import { persistent } from "../store.js";
import { ModelSelector } from "./modelSelector.js";
import { ExpandableTextarea } from "./expandableTextarea.js";
import { generateSpeech } from "../api/speech.js";

const DEFAULT_VOICES = ["coral", "alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const CACHE_KEY = "playground-speech-voices-cache";

function getVoicesCache() {
  try {
    const saved = localStorage.getItem(CACHE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}
function saveVoicesCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { console.error(e); }
}

function formatTimestamp(d) {
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function SpeechInterface() {
  const selectedModel = persistent("playground-speech-model", "");
  const selectedVoice = persistent("playground-speech-voice", "coral");
  const autoPlay = persistent("playground-speech-autoplay", false);

  let inputText = "";
  let isGenerating = false;
  let generatedAudioUrl = null;
  let generatedVoice = null;
  let generatedTimestamp = null;
  let error = null;
  let abortController = null;
  let availableVoices = [...DEFAULT_VOICES];
  let isLoadingVoices = false;

  const root = el(`
    <div class="pg-speech">
      <div class="pg-speech-toolbar" data-toolbar></div>
      <div class="pg-speech-stage" data-stage></div>
      <div class="pg-speech-input" data-input></div>
    </div>
  `);

  const toolbar = root.querySelector("[data-toolbar]");
  const stageEl = root.querySelector("[data-stage]");
  const inputEl = root.querySelector("[data-input]");

  const modelSel = ModelSelector({ value: selectedModel, placeholder: "Select a speech model..." });
  toolbar.appendChild(modelSel.el);

  const voiceWrap = el(`<div class="pg-speech-voice-wrap"></div>`);
  toolbar.appendChild(voiceWrap);

  function renderVoices() {
    const cache = getVoicesCache();
    const showRefresh = selectedModel.get() && !cache[selectedModel.get()];
    voiceWrap.innerHTML = `
      <select class="pg-input" data-voice ${isGenerating || isLoadingVoices || !selectedModel.get() ? "disabled" : ""}>
        ${availableVoices.map((v) => `<option value="${v}" ${v === selectedVoice.get() ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}
        <option value="(refresh)">(refresh)</option>
      </select>
      ${showRefresh ? `
        <button class="btn pg-speech-refresh" data-refresh title="${isLoadingVoices ? "Loading voices..." : "Load voices for this model"}" ${isLoadingVoices ? "disabled" : ""}>
          ${isLoadingVoices ? `<span class="spinner spinner-sm"></span>` : `<svg class="icon-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>`}
        </button>` : ""}
    `;
  }

  voiceWrap.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-voice]");
    if (!sel) return;
    const v = sel.value;
    if (v === "(refresh)") refreshVoices();
    else selectedVoice.set(v);
  });
  voiceWrap.addEventListener("click", (e) => {
    if (e.target.closest("[data-refresh]")) refreshVoices();
  });

  // Initial load: restore cached voices for selected model
  {
    const cache = getVoicesCache();
    const m = selectedModel.get();
    if (m && cache[m]) availableVoices = cache[m];
  }

  async function refreshVoices() {
    const model = selectedModel.get();
    if (!model || isLoadingVoices) return;
    isLoadingVoices = true;
    renderVoices();
    let voices = DEFAULT_VOICES;
    try {
      const data = await (await fetchOk(`/v1/audio/voices?model=${encodeURIComponent(model)}`)).json();
      const list = Array.isArray(data) ? data : data.voices || DEFAULT_VOICES;
      if (list.length > 0) voices = list;
    } catch {
      // fetch/parse failure falls back to the default voice list
    }
    availableVoices = voices;
    // cache before the voice change so the subscriber's re-render sees it
    const cache = getVoicesCache();
    cache[model] = voices;
    saveVoicesCache(cache);
    selectedVoice.set(voices[0]);
    isLoadingVoices = false;
    renderVoices();
  }

  function renderStage() {
    if (isGenerating) {
      stageEl.innerHTML = pgSpinner("pg-speech-msg", "Generating speech...");
      return;
    }
    if (error) {
      stageEl.innerHTML = pgError("pg-speech-msg", error);
      return;
    }
    if (generatedAudioUrl) {
      stageEl.innerHTML = `
        <div class="pg-speech-player">
          <div class="pg-speech-meta">
            ${generatedVoice ? `<span>🎤 ${escapeHtml(generatedVoice)}</span>` : ""}
            ${generatedTimestamp ? `<span>🕒 ${escapeHtml(formatTimestamp(generatedTimestamp))}</span>` : ""}
            <button class="btn pg-speech-dl" data-dl title="Download audio file">
              <svg class="icon-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            </button>
          </div>
          <audio controls class="pg-speech-audio">
            <source src="${generatedAudioUrl}" type="audio/mpeg">
          </audio>
        </div>`;
      const a = stageEl.querySelector("audio");
      if (a && autoPlay.get()) {
        a.load();
        a.play().catch(() => {});
      }
      return;
    }
    stageEl.innerHTML = `
      <div class="pg-speech-msg muted">
        <svg class="icon-16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
        <p>Enter text below to convert to speech</p>
      </div>`;
  }

  stageEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-dl]")) downloadAudio();
  });

  // ---- Input row ----
  const ta = ExpandableTextarea({
    value: {
      get: () => inputText,
      set: (v) => { inputText = v; updateGenState(); },
      subscribe: () => () => {},
    },
    placeholder: "Enter text to convert to speech...",
    rows: 8,
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generate(); } },
  });
  inputEl.appendChild(ta.el);

  const actions = el(`<div class="pg-speech-actions"></div>`);
  inputEl.appendChild(actions);

  function renderActions() {
    if (isGenerating) {
      actions.innerHTML = `<button class="btn pg-btn-cancel" data-cancel>Cancel</button>`;
      return;
    }
    actions.innerHTML = `
      <button class="btn btn--primary" data-gen>Generate</button>
      <button class="btn" data-clear>Clear</button>
      <label class="pg-speech-autoplay">
        <input type="checkbox" data-autoplay ${autoPlay.get() ? "checked" : ""}>
        Auto-play
      </label>
    `;
  }
  function updateGenState() {
    const b = actions.querySelector("[data-gen]");
    if (b) b.disabled = !inputText.trim() || !selectedModel.get();
    const c = actions.querySelector("[data-clear]");
    if (c) c.disabled = !inputText.trim();
  }
  actions.addEventListener("click", (e) => {
    if (e.target.closest("[data-gen]")) generate();
    else if (e.target.closest("[data-cancel]")) abortController?.abort();
    else if (e.target.closest("[data-clear]")) { inputText = ""; ta.el.querySelector("textarea").value = ""; updateGenState(); }
  });
  actions.addEventListener("change", (e) => {
    if (e.target.hasAttribute("data-autoplay")) autoPlay.set(e.target.checked);
  });

  async function generate() {
    const trimmed = inputText.trim();
    if (!trimmed || !selectedModel.get() || isGenerating) return;
    isGenerating = true;
    error = null;
    const task = runTask(playgroundStores.speechGenerating, async (signal) => {
      const blob = await generateSpeech(selectedModel.get(), trimmed, selectedVoice.get(), signal);
      if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
      generatedAudioUrl = URL.createObjectURL(blob);
      generatedVoice = selectedVoice.get();
      generatedTimestamp = new Date();
    });
    abortController = task;
    renderStage();
    renderActions();
    const { error: err } = await task;
    isGenerating = false;
    abortController = null;
    error = err;
    renderStage();
    renderActions();
    updateGenState();
  }

  function downloadAudio() {
    if (!generatedAudioUrl) return;
    const ts = (generatedTimestamp || new Date()).toISOString().replace(/[:.]/g, "-").slice(0, -5);
    triggerDownload(generatedAudioUrl, `${generatedVoice || "speech"}-${ts}.mp3`);
  }

  const subs = [
    subscribeHasModels(root),
    selectedModel.subscribe(() => {
      renderVoices();
      updateGenState();
    }),
    selectedVoice.subscribe(renderVoices),
  ];

  renderVoices();
  renderStage();
  renderActions();
  updateGenState();

  return {
    el: root,
    destroy() {
      if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
      cleanupAll([modelSel.destroy, ta.destroy, ...subs]);
    },
  };
}
