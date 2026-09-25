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

// Flattens the grouped model list into ordered picker options. Each option
// carries the group it belongs to, its parent model, and — for aliases — the
// model id it points at. Order: local models (aliases after each), then peer
// groups alphabetically.
export function buildModelOptions(models) {
  const grouped = groupModels(models);
  const out = [];
  for (const m of grouped.local) {
    out.push({ value: m.id, group: "Local", model: m, aliasOf: null });
    for (const a of m.aliases ?? []) {
      out.push({ value: a, group: "Local", model: m, aliasOf: m.id });
    }
  }
  for (const [peerId, peerModels] of Object.entries(grouped.peersByProvider).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    for (const m of peerModels) {
      out.push({ value: m.id, group: `Peer: ${peerId}`, model: m, aliasOf: null });
    }
  }
  return out;
}

// Filters picker options by a case-insensitive substring on the value or the
// model's display name. Alias rows also match on their own id, but stay
// visible when only their parent model matches (the picker indents them, so
// an alias orphaned by the filter would lose its context).
export function filterModelOptions(options, query, match = null) {
  const q = String(query ?? "").trim().toLowerCase();
  let filtered = options.filter((o) => {
    if (!q) return true;
    const parent = o.aliasOf ?? o.value;
    return (
      o.value.toLowerCase().includes(q) ||
      parent.toLowerCase().includes(q) ||
      (o.model?.name ?? "").toLowerCase().includes(q)
    );
  });
  if (match) {
    // Stable sort: options satisfying the tab's needs float to the top of
    // their group ordering.
    filtered = filtered
      .map((o, i) => ({ o, i, fits: !!match(o.model, o.value) }))
      .sort((a, b) => (a.fits === b.fits ? a.i - b.i : a.fits ? -1 : 1))
      .map(({ o }) => o);
  }
  return filtered;
}
