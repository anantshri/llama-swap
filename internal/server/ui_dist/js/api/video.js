// OpenAI-compatible video generation (vLLM-omni style). Port of
// lib/videoApi.ts from upstream PR #991; session headers are omitted to
// match this fork's other playground APIs.

// The vLLM-omni docs only confirm "queued" and "completed" status values,
// so polling treats "completed" as success, these strings as terminal
// failure, and anything else as still in progress.
export const TERMINAL_FAILURE_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

// buildVideoFormData assembles the multipart body. Backend-specific
// extension fields (e.g. vLLM-omni's width/height/num_frames/seed/
// extra_params) ride in params.advanced: scalars are sent as plain
// strings, objects/arrays are JSON-encoded. Applied last so it overrides
// the basic fields, and "model" is never overridable since it drives
// llama-swap's routing.
export function buildVideoFormData(model, prompt, params = {}, referenceFile = null) {
  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", prompt);
  if (params.size) formData.append("size", params.size);
  if (params.seconds !== undefined) formData.append("seconds", String(params.seconds));
  if (params.fps !== undefined) formData.append("fps", String(params.fps));
  if (params.negativePrompt) formData.append("negative_prompt", params.negativePrompt);
  if (referenceFile) formData.append("input_reference", referenceFile);
  if (params.advanced) {
    for (const [key, value] of Object.entries(params.advanced)) {
      if (key === "model" || value === undefined) continue;
      formData.set(key, typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));
    }
  }
  return formData;
}

async function postVideoForm(path, formData, signal) {
  const response = await fetch(path, { method: "POST", body: formData, signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video API error: ${response.status} - ${errorText}`);
  }
  return response;
}

/** POST /v1/videos - creates an async video generation job. */
export async function createVideoJob(model, prompt, params, referenceFile, signal) {
  const response = await postVideoForm("/v1/videos", buildVideoFormData(model, prompt, params, referenceFile), signal);
  return response.json();
}

/** POST /v1/videos/sync - blocks until the video is generated. */
export async function createVideoSync(model, prompt, params, referenceFile, signal) {
  const response = await postVideoForm("/v1/videos/sync", buildVideoFormData(model, prompt, params, referenceFile), signal);
  return response.blob();
}

// GET/DELETE /v1/videos/{id}... routes carry no model in the request body,
// so llama-swap dispatches them via a required ?model= query param (same
// convention as /props).

export async function getVideoStatus(id, model, signal) {
  const url = `/v1/videos/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}`;
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video API error: ${response.status} - ${errorText}`);
  }
  return response.json();
}

export async function getVideoContent(id, model, signal) {
  const url = `/v1/videos/${encodeURIComponent(id)}/content?model=${encodeURIComponent(model)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video API error: ${response.status} - ${errorText}`);
  }
  return response.blob();
}

export async function deleteVideo(id, model, signal) {
  const url = `/v1/videos/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}`;
  const response = await fetch(url, { method: "DELETE", signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video API error: ${response.status} - ${errorText}`);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function formatJobError(error) {
  if (!error) return "";
  return typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
}

/**
 * Creates an async video job and polls it to completion, returning the
 * rendered video bytes. onStatus is invoked after job creation and after
 * every poll so callers can render progress.
 */
export async function generateVideoAsync(model, prompt, params, referenceFile, signal, onStatus, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  let current = await createVideoJob(model, prompt, params, referenceFile, signal);
  onStatus?.(current);

  const deadline = Date.now() + timeoutMs;
  while (current.status !== "completed") {
    if (TERMINAL_FAILURE_STATUSES.has(current.status)) {
      const detail = formatJobError(current.error);
      throw new Error(`Video generation ${current.status}${detail ? `: ${detail}` : ""}`);
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for video generation to complete");
    }
    await sleep(pollIntervalMs, signal);
    current = await getVideoStatus(current.id, model, signal);
    onStatus?.(current);
  }

  return getVideoContent(current.id, model, signal);
}
