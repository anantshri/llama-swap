# 2026-10-12 — Capture viewer: split reasoning/content for buffered responses

## Goal

User feature request: in the Activity view's capture dialog, the response
section should show a clear reasoning block and content block, like the
request's parts view. Keep the vanilla-UI code simple.

## Change

- captureDialog.js:
  - parseChatJson(): buffered chat completion → {reasoning, content}
    (same shape as parseSSEChat; reasoning alias; multimodal content
    flattened; null for non-chat/empty).
  - responseChatHTML(): shared renderer — collapsible part-style blocks
    (role chip, label, chars/words/≈tokens) reusing the request parts CSS;
    reasoning keeps its tint; empty fields skipped.
  - Chat tab offered for any chat-shaped response; defaultRespTab lands
    chat JSON on Chat; chat Copy concatenates reasoning+content.
- No new components/stores/CSS — reuses .capture-part styles.

## Verification

- Selftest 163/163 (+6).
- Playwright E2E: fake upstream returns reasoning_content + content in a
  buffered completion; Activity → View opens the dialog on the Chat tab
  with both blocks, labels, stats; zero page errors.
- Full short suite green; aidc-scan --all clean.

## Pre-completion review outcome

Fresh-eyes review: no High findings; M1 + 4 Lows, all fixed:

- M1: parseChatJson ran unmemoized on every render() + again in
  defaultRespTab (multi-MB bodies) — added responseChatFor() memo cache,
  shared by both call sites (mirrors partsCache).
- L2/L3: labels now report the actual source field (choices[0].message vs
  .delta, reasoning_content vs reasoning); empty-string reasoning_content
  no longer shadows a populated reasoning alias.
- L1: dead .capture-chat CSS rules removed.
- L4: +4 controller-level selftests (real dialog via CaptureDialogController:
  buffered-chat lands on Chat with source labels, non-chat JSON keeps
  Pretty with no Chat tab, SSE keeps Chat with delta labels) → 167/167.
- L5: changelog separator dedup.

Final gates: suite 1987/32 ok, aidc-scan --all clean, selftest 167/167.

## Notes

- To find the capture opener in the browser: Activity row "View" button
  (text=View), not a data-capture attribute.
- Selector-first E2E script initially failed guessing attribute names;
  inspecting body text found the "View" button.
