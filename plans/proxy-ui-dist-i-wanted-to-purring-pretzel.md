# Plan: Replace the Svelte UI build with a hand-authored, build-free static UI

## Context

`proxy/ui_dist/` is the **compiled output of the Svelte web UI** (source in `ui-svelte/`), embedded into the Go binary via `//go:embed ui_dist` (`proxy/ui_embed.go`) and served at `/ui/` (`proxy/proxymanager.go:479`). Today the directory is gitignored (`proxy/.gitignore` → `ui_dist/*`) except a `placeholder.txt`; the real assets are produced by `cd ui-svelte && npm run build` (Vite), which is also wired into `make ui`, all platform build targets, `make test-ui`, and CI (`release.yml`, `ui-tests.yml`).

The user does not want npm/node in the codebase. We are removing the **entire JS build toolchain** — no npm, node, Vite, or bundler — and replacing the Svelte app with **plain static HTML/CSS/JS committed to git**, so building the Go binary requires zero JS tooling.

**Locked decisions:**
- **Third-party libs**: vendor standalone browser bundles under `proxy/ui_dist/vendor/` (chart.js, marked, katex, highlight.js), loaded via plain `<script>`/`<link>`. No runtime CDN; must work offline.
- **Styling**: hand-written static CSS replacing Tailwind v4, preserving light/dark theme + responsive behavior.
- **Scope**: full 1:1 feature parity with the current UI.

**Scope reality:** `ui-svelte/src/` is ~7,300 lines across 26 components (streaming chat with 3 SSE wire formats, markdown+math+code rendering, chart.js dashboard, image/SD/audio/speech/rerank playground, live SSE, persistent settings). This is a ~7–10 working-day rewrite. The plan lands it incrementally so `/ui` keeps working throughout.

## Verified facts (grounding the approach)

- **Native ES modules work under the embed FS.** `/ui/*filepath` (`proxymanager.go:479`) serves any extensioned path; the `NoRoute` SPA fallback (`:490`) only returns `index.html` for `/ui` paths *without* a `.` extension. So `import './foo.js'` resolves as a real file; no bundler needed. Vendored libs load as classic `<script>` (UMD globals) before the module entry.
- **Uncompressed-only serving is safe.** `ServeCompressedFile` (`ui_compress.go:34`) opens `name+".gz"/".br"` and **falls through to the uncompressed file when absent** (`:62`). We commit no `.gz`/`.br`; serving still works. The synthetic-FS compression tests (`fstest.MapFS`) stay green; `TestServeCompressedFile_RealFiles` `t.Skip`s when no `assets/` + `.gz` sibling exists (retarget it — see Teardown).
- **`favicon.ico` must stay committed** — read directly at `proxymanager.go:466`.
- **`embed.FS` rejects an empty dir** — once `ui_dist/index.html` + assets are committed, the `placeholder.txt` rule and the `.gitignore` exclusion both go away.
- **`listModels()` (`stores/api.ts:137`) is dead code** — it fetches `/api/models/`, which has no route. The model list arrives via the SSE `modelStatus` event. Do not port it.
- **Backend needs no API changes.** Every endpoint the UI calls is already registered.
- **lucide-svelte is used in only 2 files** — replace with inline SVG string constants (`js/icons.js`).

## Target layout (`proxy/ui_dist/`, all hand-authored + committed)

```
index.html                 # head/favicons + vendor <script>/<link> + <script type="module" src="/ui/js/main.js">
favicon.ico  favicon.svg  *.png  site.webmanifest
css/ app.css  chat.css     # theme tokens + utilities + components; chat/prose styles
vendor/ chart.umd.js  marked.min.js  katex.min.js  katex.min.css  katex/fonts/...
        highlight.min.js  highlight.css
js/
  main.js                  # bootstrap: theme, SSE, router, header, mount pages
  store.js                 # observable() pub/sub + all app stores
  router.js  sse.js  dom.js  markdown.js  icons.js
  api/    chat.js image.js sd.js audio.js speech.js rerank.js
  util/   histogram.js modelUtils.js content.js
  pages/  playground.js models.js logs.js activity.js performance.js
  components/  header.js resizablePanels.js captureDialog.js tokenHistogram.js
               performanceChart.js chatMessage.js chatInterface.js imageInterface.js
               speechInterface.js audioInterface.js rerankInterface.js modelSelector.js
               expandableTextarea.js logPanel.js modelsPanel.js activityStats.js
               connectionStatus.js tooltip.js
  __selftest.html          # in-browser port of markdown.test.ts / histogram.test.ts (replaces vitest)
```

All `/ui/`-absolute paths (app is served from `/ui`; `/` redirects to `/ui`). KaTeX CSS references its fonts relatively — commit `katex/fonts/` so math renders offline.

## Architecture (vanilla JS, no framework)

- **Store layer (`js/store.js`)** — `observable(initial)` exposing `get/set/update/subscribe` (subscribe fires immediately, matching Svelte's `writable` contract so ported logic works unchanged), plus `derived(deps, fn)` and `persistent(key, initial)` (localStorage-backed). Mapping:
  - `stores/api.ts` → observables + `sse.js`: port `appendLog` (100 KB cap), the `modelStatus/logData/metrics/inflight` switch, and the `connectionState`→fetch `/api/version` effect. Drop dead `listModels`.
  - `stores/theme.ts` → observables + init in `main.js`; the `data-theme` attribute effect and connection-icon document.title effect become subscriptions (replacing App.svelte `$effect`s).
  - `stores/persistent.ts` → `persistent()`; `playgroundActivity.ts` → 5 booleans + derived OR; `route.ts` → owned by router.
- **Router (`js/router.js`)** — hash-based, same routes: `/` Playground (kept mounted, toggled via `display`), `/models`, `/logs`, `/activity`, `/performance`, `*`→Playground. On `hashchange`, `unmount()` the prior non-root page (critical for Performance's poll timer + chart `destroy()`), mount the new one.
- **Components** — factories returning `{ el, update?, destroy? }`: render a template string once, cache mutable nodes, update them on store subscriptions, unsubscribe in `destroy`. Small lists re-render their container; chat streams incrementally.
- **Streaming chat (hardest)** — `chatMessage.js` owns a prose container + ported `StreamingCache`; `appendChunk(text)` calls `renderStreamingMarkdown(full, cache)`, appends a `<div>` per new settled block id and replaces only the trailing pending `<div>` (preserves the existing incremental optimization). Reuse the framework-agnostic `codeBlockCopy` `MutationObserver` for copy buttons. Reasoning toggle / edit / regenerate / raw view / image modal → event listeners + `display` toggles; abort + reasoning timing port verbatim from `ChatInterface.svelte`.

## lib/ → js/ mapping

**Near-verbatim (strip types only):**
- `chatApi.ts` → `api/chat.js` — port the 3-format SSE parsing exactly (OpenAI chat-completions `data:` chunks; Anthropic `content_block_delta`/`message_stop`; Responses `response.output_text.delta`/`response.completed`), plus request builders. Plain generators over `fetch().body.getReader()`.
- `imageApi.ts`/`sdApi.ts`/`audioApi.ts`/`speechApi.ts`/`rerankApi.ts` → `api/*.js`; `histogram.ts`/`modelUtils.ts` → `util/`; runtime helpers from `types.ts` (`getTextContent`, `getImageUrls`) → `util/content.js`.

**Rework — `markdown.ts` → `markdown.js` (riskiest file):** the streaming helpers (`splitCompleteBlocks`, `closePendingBlock`, `createStreamingCache`, `renderStreamingMarkdown`, `normalizeLatexDelimiters`, `escapeHtml`) are pure string logic — **port verbatim**. Only `renderMarkdown()` changes to: (1) `normalizeLatexDelimiters`; (2) `marked` with `gfm:true` + a custom code renderer running `hljs.highlight(...)` (mirrors the old `rehypeHighlight` plugin, `hljs language-xxx` classes, plaintext fallback); (3) a **marked tokenizer extension** for `$$...$$`/`$...$` → `katex.renderToString(..., {throwOnError:false})` — tokenizer-level so math is not rendered inside code spans/fences (matches remark-math); (4) same `escapeHtml` fallback on error.

## Styling (`css/app.css`, `css/chat.css`)

CSS custom properties for theming (already the pattern in `index.css`) + a compact hand-written utility subset (only the Tailwind utilities actually in use, enumerated by grepping `class=` across the Svelte tree) + the existing semantic classes (`.btn`, `.card`, `.status*`, `.navlink`, `.prose`).
- Copy `:root` / `[data-theme="dark"]` token blocks verbatim; drop Tailwind `@theme`/`@apply`/`@layer` directives.
- Dark mode: `data-theme="dark"` on `<html>` set by the theme subscription; everything resolves via `var(--color-*)`. Port the hljs dark override.
- Responsive: media queries at the existing breakpoints (`sm:640 md:768 lg:1024 xl:1280 2xl:1536`, mirrored in `theme.ts:checkScreenWidth`); keep the JS `screenWidth`/`isNarrow` store for components that branch imperatively (ResizablePanels, log layout).
- Component `<style>` blocks (ChatMessage `.prose`) move into `chat.css` without `:global()`.

## Compression / serving

Commit uncompressed files only; rely on the verified uncompressed fallback. No Go change for correctness. Retarget `TestServeCompressedFile_RealFiles` (`ui_compress_test.go`) to scan `./ui_dist` (not `./ui_dist/assets`) and skip cleanly when no compressed sibling exists; leave the synthetic-FS tests untouched.

## Toolchain teardown

- **Makefile**: delete the `proxy/ui_dist/placeholder.txt` rule and its prerequisite on `test-dev`/`test`/`test-all`/`gosec`; delete `ui/node_modules`, `ui`, `test-ui` targets; remove the `ui` prerequisite from `mac`/`linux-amd64`/`linux-arm64`/`windows`; update `.PHONY`.
- **CI**: `release.yml` — remove the Node setup + `npm ci && npm run build` steps (goreleaser builds straight from committed `ui_dist`). `ui-tests.yml` — delete, or replace with `go test ./proxy/...` for the new serving smoke test. `go-ci.yml` — no placeholder creation needed once `index.html` is committed.
- **`proxy/.gitignore`**: remove `ui_dist/*` so the hand-authored tree is tracked (optionally keep a narrow ignore for `*.gz`/`*.br`).
- **`.goreleaser.yaml`**: confirm no npm `before.hooks`.
- **`ui-svelte/`**: unwire now; keep for one release as reference; delete in a follow-up once parity is confirmed.

## Verification

- **Self-test page** `proxy/ui_dist/__selftest.html` (served at `/ui/__selftest.html`): in-browser port of `markdown.test.ts` (423 lines) + `histogram.test.ts` (167 lines) + canned-chunk tests for each `parse*Stream`, printing pass/fail — replaces vitest with zero build step.
- **Go serving smoke test**: assert `GET /ui/`, `/ui/js/main.js`, `/ui/vendor/marked.min.js`, `/ui/css/app.css` → 200 with sane Content-Type; `/ui/some/spa/route` → `index.html`.
- **Manual checklist**: `make simple-responder`, then run the server and open `http://localhost:<port>/` (→ `/ui`). Verify every page — Playground tabs (Chat streaming across all 3 endpoints incl. reasoning + image paste + edit/regenerate/raw/copy; Images; Speech; Audio; Rerank), Models (load/unload + upstream logs), Logs (panes + view-mode + ResizablePanels drag + persistence), Activity (13 column toggles persistence + capture dialog), Performance (all charts, window selector, polling, dark/light recolor). Toggle theme, resize to narrow, reload (localStorage persistence), kill server (SSE backoff reconnect + title icon).
- Run `gofmt -l .`, `make test-all`, and `make gosec` before completion (per repo guardrails).

## Phasing (~7–10 working days)

- **A — Scaffold + serving (0.5–1d):** commit `index.html`, core `js/` (main/store/router/sse/dom), vendored libs, `app.css` skeleton with theme tokens, empty page shells; wire SSE + theme + header. Flip `.gitignore` + Makefile here so the static tree becomes the single live UI (shells render even when incomplete). Add the Go serving smoke test.
- **B — Models + Logs + Activity (1–1.5d):** tables, log panes, ResizablePanels, capture dialog, column toggles. Exercises store/SSE end-to-end.
- **C — Performance (0.5–1d):** `performanceChart.js` (chart.js wrapper, dark recolor subscription, `chart.update('none')`), dataset derivation (CPU per-core, mem/swap, load, net deltas, GPU metrics); chart lifecycle via router `unmount()`.
- **D — Playground non-chat (1–1.5d):** Images, Speech, Audio, Rerank, ModelSelector, ExpandableTextarea, tab shell.
- **E — Chat + markdown (1.5–2.5d, riskiest):** `markdown.js` rework + `chatMessage.js` streaming DOM + `chatInterface.js`; build `__selftest.html`.
- **F — Styling polish + responsive (1–1.5d):** complete utility subset, finalize `chat.css`, dark/breakpoint pass, screenshot-diff vs the Svelte app.
- **G — Teardown + cleanup (0.5d):** finalize Makefile/CI/.gitignore, retarget the real-files test, confirm `make mac/linux/windows` build with zero JS tooling, schedule `ui-svelte/` deletion.

## Riskiest parts & de-risking

1. **Streaming markdown** — new renderer under ported streaming logic; de-risk with `__selftest.html` mirroring `markdown.test.ts` and the tokenizer-level math isolation.
2. **3-format SSE chat parsing** — port verbatim; drive each parser over canned chunks; verify against a live llama-server.
3. **chart.js lifecycle** — explicit destroy on `unmount()`; dataset derivation is pure functions, eyeball against the Svelte source.
4. **Responsive fidelity** — enumerate used utilities mechanically before writing CSS; screenshot-diff each page at xs/sm/md/lg.

## Critical files

- `proxy/ui_dist/index.html` (vendor + module load order), `proxy/ui_dist/js/markdown.js` (riskiest rework), `proxy/ui_dist/js/api/chat.js` (3-format SSE)
- `proxy/proxymanager.go:440-507` (UI serving — no change expected), `proxy/ui_embed.go`, `proxy/ui_compress_test.go` (retarget real-files test)
- `Makefile`, `proxy/.gitignore`, `.github/workflows/{release,ui-tests}.yml`
