// TTS generation. Port of lib/speechApi.ts; the fetch/ok-check/error-text
// shape lives in apiFetch (api.js).
import { apiFetch, postJSON } from "../api.js";

export async function generateSpeech(model, input, voice, signal) {
  const response = await apiFetch("/v1/audio/speech", postJSON({ model, input, voice }, signal), "Speech API error");
  return response.blob();
}
