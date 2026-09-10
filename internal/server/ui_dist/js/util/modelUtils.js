// Verbatim port of lib/modelUtils.ts.
export function groupModels(models) {
  const available = models.filter((m) => !m.unlisted);
  const local = available.filter((m) => !m.peerID);
  const peerModels = available.filter((m) => m.peerID);
  const peersByProvider = peerModels.reduce((acc, m) => {
    const k = m.peerID || "unknown";
    (acc[k] = acc[k] || []).push(m);
    return acc;
  }, {});
  return { local, peersByProvider };
}

// Model status badge + upstream URL helpers, shared by the models list
// (modelsPanel) and the model detail page.
export function statusDotClass(m) {
  if (!m) return "status-dot status-dot--idle";
  if (m.state === "ready") return "status-dot status-dot--ready";
  if (m.state === "starting" || m.state === "stopping") return "status-dot status-dot--transition";
  return "status-dot status-dot--idle";
}

export function modelServerPath(modelId) {
  if (modelId === "comfyui_auto") return "/comfyui/";
  return `/upstream/${encodeURIComponent(modelId)}/`;
}
