# Settings page: Build Information always "unknown"

## Symptom

Settings → Build Information showed `unknown` for Version, Commit Hash, and
Build Date (Event Stream showed `connected`, so the UI was reaching the
server fine). The header's connection tooltip had the same problem.

## Diagnosis

- `GET /api/version` (`internal/server/apigroup.go` `handleAPIVersion`)
  serves `{version, commit, build_date}` from `s.build`, populated via
  `-ldflags -X main.*` in the Makefile — server side is fine.
- The UI's `versionInfo` store (`ui_dist/js/api.js`) is initialized to
  `"unknown"` and **nothing ever sets it**: no fetch of `/api/version`
  anywhere in `ui_dist/`, and no SSE event carries version info
  (`handleAPIEventMessage` handles modelStatus/logData/activity/inflight/
  uiConfig/profileChanged only).
- `ui_dist/js/pages/settings.js` (`renderBuild`) and
  `ui_dist/js/components/header.js` (`updateConn`) subscribe to the store,
  so they keep rendering the initial placeholders. The populate step was
  evidently lost when the Svelte UI was ported to the hand-authored ES
  modules.

## Change

```diff
--- internal/server/ui_dist/js/api.js
+// Build metadata is static for the process lifetime; fetched once at boot so
+// the settings page and header tooltip can display it.
+export async function fetchVersionInfo() {
+  try {
+    const response = await fetch("/api/version");
+    if (!response.ok) return;
+    const v = await response.json();
+    versionInfo.set({
+      version: v.version ?? "unknown",
+      commit: v.commit ?? "unknown",
+      build_date: v.build_date ?? "unknown",
+    });
+  } catch {
+    // Network failure leaves the "unknown" defaults in place.
+  }
+}

--- internal/server/ui_dist/js/main.js
-import { enableAPIEvents } from "./api.js";
+import { enableAPIEvents, fetchVersionInfo } from "./api.js";
 ...
   enableAPIEvents(true);
+  fetchVersionInfo().catch((err) => console.error(err));
```

Same session, per user request: removed `max-width: 34rem` from
`.page-settings` in `ui_dist/css/newpages.css` so the Settings page uses
the full content width.

## Commands

- `go test -short ./internal/server/` — 365 passed (includes the UI
  serving/embedding tests).
- `aidc-scan` — clean.

## Verification notes
- `node` is not installed in the container, so the ES modules were
  syntax-checked by review; no JS build step exists for this UI by design.
- A binary built with plain `go build` (no Makefile ldflags) will show the
  compile-time defaults (`0`, `abcd1234`, `unknown`) — that is the binary's
  metadata, not a UI bug.
