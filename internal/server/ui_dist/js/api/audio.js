// Audio transcription. Port of lib/audioApi.ts; the fetch/ok-check/error-text
// shape lives in apiFetch (api.js).
import { apiFetch } from "../api.js";

export async function transcribeAudio(model, file, signal) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("model", model);
  const response = await apiFetch("/v1/audio/transcriptions", { method: "POST", body: fd, signal }, "Audio API error");
  return response.json();
}
