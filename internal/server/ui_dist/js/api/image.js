// OpenAI-compatible image generation. Port of lib/imageApi.ts; the
// fetch/ok-check/error-text shape lives in apiFetch (api.js).
import { apiFetch, postJSON } from "../api.js";

export async function generateImage(model, prompt, size, signal) {
  const response = await apiFetch("/v1/images/generations", postJSON({ model, prompt, n: 1, size }, signal), "Image API error");
  return response.json();
}
