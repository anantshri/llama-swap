// Video generation tab: async/sync /v1/videos with job polling. Ported
// from ui-svelte's VideoInterface.svelte (upstream PR #991), kept lean.
import { el, escapeHtml } from "../dom.js";
import { persistent } from "../store.js";
import { ModelSelector } from "./modelSelector.js";
import { playgroundModels } from "../api.js";
import { generateVideoAsync, createVideoSync, deleteVideo } from "../api/video.js";

export function VideoInterface() {
  const selectedModel = persistent("playground-video-model", "");
  const selectedMode = persistent("playground-video-mode", "async");
  const selectedSize = persistent("playground-video-size", "");
  const selectedSeconds = persistent("playground-video-seconds", "");
  const advancedJson = persistent("playground-video-advanced", "");
  const negativePrompt = persistent("playground-video-negative", "");

  let prompt = "";
  let referenceFile = null;
  let isGenerating = false;
  let abortController = null;
  let jobs = []; // {id, model, status, error, url, done}
  let error = null;

  const root = el(`
    <div class="pg-video">
      <div class="pg-image-toolbar" data-toolbar></div>
      <div class="pg-image-settings" data-settings style="display:none"></div>
      <div class="pg-video-stage" data-stage></div>
      <div class="pg-image-prompt-row" data-prompt-row></div>
    </div>
  `);
  const toolbarEl = root.querySelector("[data-toolbar]");
  const settingsEl = root.querySelector("[data-settings]");
  const stageEl = root.querySelector("[data-stage]");
  const promptRowEl = root.querySelector("[data-prompt-row]");

  const modelSel = ModelSelector({
    value: selectedModel,
    placeholder: "Select a video model...",
    disabled: false,
    match: (m) => !!(m.capabilities?.video_generation ?? m.capabilities?.image_to_video ?? m.capabilities?.video_to_video),
  });
  toolbarEl.appendChild(modelSel.el);

  const modeSel = el(`<select class="pg-input" data-mode>
    <option value="async">Async</option>
    <option value="sync">Sync</option>
  </select>`);
  modeSel.value = selectedMode.get();
  modeSel.addEventListener("change", () => selectedMode.set(modeSel.value));
  toolbarEl.appendChild(modeSel);

  const sizeInput = el(`<input class="pg-input" data-size placeholder="size (e.g. 1280x720)" style="max-width:11rem">`);
  sizeInput.value = selectedSize.get();
  sizeInput.addEventListener("change", () => selectedSize.set(sizeInput.value.trim()));
  toolbarEl.appendChild(sizeInput);

  const settingsToggle = el(`<button class="pg-input pg-btn" data-toggle-settings>Settings</button>`);
  settingsToggle.addEventListener("click", () => {
    const open = settingsEl.style.display === "none";
    settingsEl.style.display = open ? "" : "none";
  });
  toolbarEl.appendChild(settingsToggle);

  settingsEl.innerHTML = `
    <label class="pg-setting">seconds <input class="pg-input" data-seconds type="number" min="1" step="1" placeholder="seconds" style="max-width:6rem"></label>
    <label class="pg-setting">fps <input class="pg-input" data-fps type="number" min="1" step="1" placeholder="fps" style="max-width:6rem"></label>
    <label class="pg-setting">negative prompt <input class="pg-input" data-negative placeholder="negative_prompt"></label>
    <label class="pg-setting">advanced JSON <input class="pg-input" data-advanced placeholder='{"num_frames":121,"seed":42}'></label>
    <label class="pg-setting">reference image <input class="pg-input" data-file type="file" accept="image/*"></label>`;
  const secondsInput = settingsEl.querySelector("[data-seconds]");
  secondsInput.value = selectedSeconds.get();
  secondsInput.addEventListener("change", () => selectedSeconds.set(secondsInput.value));
  settingsEl.querySelector("[data-negative]").value = negativePrompt.get();
  settingsEl.querySelector("[data-negative]").addEventListener("change", (e) => negativePrompt.set(e.target.value));
  settingsEl.querySelector("[data-advanced]").value = advancedJson.get();
  settingsEl.querySelector("[data-advanced]").addEventListener("change", (e) => advancedJson.set(e.target.value));
  settingsEl.querySelector("[data-file]").addEventListener("change", (e) => {
    referenceFile = e.target.files?.[0] ?? null;
  });

  function params() {
    const p = {};
    if (selectedSize.get()) p.size = selectedSize.get();
    if (selectedSeconds.get()) p.seconds = Number(selectedSeconds.get());
    const fps = settingsEl.querySelector("[data-fps]").value;
    if (fps) p.fps = Number(fps);
    if (negativePrompt.get()) p.negativePrompt = negativePrompt.get();
    if (advancedJson.get().trim()) {
      try {
        p.advanced = JSON.parse(advancedJson.get());
      } catch {
        throw new Error("advanced JSON is not valid JSON");
      }
    }
    return p;
  }

  promptRowEl.innerHTML = `
    <textarea class="pg-input pg-image-prompt" data-prompt rows="2" placeholder="Describe the video to generate..."></textarea>
    <button class="btn pg-generate-btn" data-generate>Generate</button>
    <button class="btn" data-stop style="display:none">Stop</button>`;
  const promptEl = promptRowEl.querySelector("[data-prompt]");
  const generateBtn = promptRowEl.querySelector("[data-generate]");
  const stopBtn = promptRowEl.querySelector("[data-stop]");
  promptEl.addEventListener("input", () => (prompt = promptEl.value));
  generateBtn.addEventListener("click", () => generate());
  stopBtn.addEventListener("click", () => abortController?.abort());

  function setGenerating(on) {
    isGenerating = on;
    generateBtn.disabled = on;
    stopBtn.style.display = on ? "" : "none";
  }

  function renderStage() {
    stageEl.innerHTML = "";
    if (error) {
      stageEl.innerHTML += `<div class="pg-error muted">${escapeHtml(error)}</div>`;
    }
    if (jobs.length === 0 && !error) {
      stageEl.innerHTML += `<div class="pg-video-empty muted">Generated videos appear here.</div>`;
      return;
    }
    for (const job of jobs) {
      const card = el(`
        <div class="pg-video-job" data-job="${escapeHtml(job.id)}">
          <div class="pg-video-job-head">
            <span class="model-tag">${escapeHtml(job.status)}</span>
            ${job.error ? `<span class="pg-error">${escapeHtml(job.error)}</span>` : ""}
            ${job.done ? `<button class="btn btn--sm" data-del title="Delete job">✕</button>` : ""}
          </div>
          ${job.url ? `<video class="pg-video-player" controls src="${job.url}"></video>` : ""}
        </div>`);
      card.querySelector("[data-del]")?.addEventListener("click", async () => {
        try {
          await deleteVideo(job.id, job.model);
          jobs = jobs.filter((j) => j.id !== job.id);
          if (job.url) URL.revokeObjectURL(job.url);
          renderStage();
        } catch (e) {
          error = e.message;
          renderStage();
        }
      });
      stageEl.appendChild(card);
    }
  }

  async function generate() {
    if (isGenerating) return;
    if (!selectedModel.get()) {
      error = "Select a video model first.";
      renderStage();
      return;
    }
    if (!prompt.trim()) {
      error = "Enter a prompt first.";
      renderStage();
      return;
    }
    let p;
    try {
      p = params();
    } catch (e) {
      error = e.message;
      renderStage();
      return;
    }
    error = null;
    abortController = new AbortController();
    setGenerating(true);
    try {
      if (selectedMode.get() === "sync") {
        const blob = await createVideoSync(selectedModel.get(), prompt, p, referenceFile, abortController.signal);
        jobs.unshift({ id: `sync-${Date.now()}`, model: selectedModel.get(), status: "completed", error: "", url: URL.createObjectURL(blob), done: true });
      } else {
        const blob = await generateVideoAsync(
          selectedModel.get(),
          prompt,
          p,
          referenceFile,
          abortController.signal,
          (job) => {
            const existing = jobs.find((j) => j.id === job.id);
            const errorText = typeof job.error === "string" ? job.error : job.error?.message ?? "";
            if (existing) {
              existing.status = job.status;
              existing.error = errorText;
            } else {
              jobs.unshift({ id: job.id, model: selectedModel.get(), status: job.status, error: errorText, url: "", done: false });
            }
            renderStage();
          }
        );
        const job = jobs.find((j) => !j.done);
        if (job) {
          job.url = URL.createObjectURL(blob);
          job.done = true;
        }
      }
      renderStage();
    } catch (e) {
      if (e?.name === "AbortError") {
        // keep partial job state; the poll loop stopped
      } else {
        error = e.message;
      }
      renderStage();
    } finally {
      setGenerating(false);
      abortController = null;
    }
  }

  const sub = playgroundModels.subscribe(() => modelSel.render?.());
  renderStage();

  return {
    el: root,
    destroy() {
      sub.unsubscribe?.();
      for (const job of jobs) if (job.url) URL.revokeObjectURL(job.url);
      abortController?.abort();
    },
  };
}
