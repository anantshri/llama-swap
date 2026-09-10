// Stable Diffusion WebUI API. Port of lib/sdApi.ts; the fetch/ok-check/
// error-text shape lives in apiFetch (api.js).
import { apiFetch, postJSON } from "../api.js";

export async function generateSdImage(request, signal) {
  const response = await apiFetch("/sdapi/v1/txt2img", postJSON(request, signal), "SDAPI error");
  return response.json();
}

export async function fetchSdLoras(model, signal) {
  const response = await apiFetch(`/sdapi/v1/loras?model=${encodeURIComponent(model)}`, { signal }, "SDAPI loras error");
  return response.json();
}
