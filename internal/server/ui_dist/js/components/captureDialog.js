// Capture dialog (request/response inspector), ported from CaptureDialog.svelte.
import { el, escapeHtml } from "../dom.js";

function decodeBody(body) {
  if (!body) return "";
  try {
    const binary = atob(body);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return body;
  }
}

function formatJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function parseJsonObject(str) {
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// countWords / estimateTokens back the request-body parts view. There is no
// tokenizer in the proxy, so token counts are an approximation: ~4 characters
// per token for the English text and JSON that dominates chat requests. Every
// surface that shows a token number labels it as an estimate.
export function countWords(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function estimateTokens(text) {
  const len = String(text ?? "").length;
  // Any non-empty text costs at least one token, so rounding never reports a
  // populated part as free.
  return len === 0 ? 0 : Math.max(1, Math.round(len / 4));
}

// contentText flattens one `content` value — a string, an array of typed
// content parts (text/image/tool_use/tool_result), or an arbitrary object —
// into the plain text that is displayed and counted.
function contentText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item === null || item === undefined) return "";
        if (typeof item === "string") return item;
        if (typeof item !== "object") return String(item);
        if (typeof item.text === "string") return item.text;
        if (typeof item.input_text === "string") return item.input_text;
        if (item.type === "image_url" || item.type === "image") {
          const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url || item.url || "";
          return `[image${url ? `: ${url}` : ""}]`;
        }
        if (item.type === "input_audio" || item.type === "audio") return "[audio]";
        if (item.type === "tool_use") return `${item.name || "tool"} ${JSON.stringify(item.input ?? {})}`;
        if (item.content !== undefined) return contentText(item.content);
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") return JSON.stringify(content, null, 2);
  return String(content);
}

// prettyArgs renders a tool-call argument payload, which is a JSON string on
// the wire and may be an object once decoded.
function prettyArgs(args) {
  if (args === null || args === undefined) return "{}";
  if (typeof args !== "string") return JSON.stringify(args, null, 2);
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function pushPart(parts, role, kind, label, text) {
  const value = String(text ?? "");
  if (!value) return;
  parts.push({
    role,
    kind,
    label,
    text: value,
    chars: value.length,
    words: countWords(value),
    tokens: estimateTokens(value),
  });
}

// splitRequestParts breaks a JSON request body into separately displayable
// parts: the top-level system prompt/instructions, one entry per chat message,
// each tool call and tool result, the tool definitions, and the prompt of the
// legacy completions API. Returns null when the body carries none of them
// (audio, images, embeddings, …).
export function splitRequestParts(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const parts = [];

  pushPart(parts, "system", "system", "system (top-level)", contentText(body.system));
  pushPart(parts, "system", "system", "instructions (top-level)", contentText(body.instructions));

  // /v1/chat/completions and /v1/messages (translated) use `messages`;
  // /v1/responses uses `input`, which is either a plain string or an array of
  // message-shaped items.
  const listName = Array.isArray(body.messages) ? "messages" : Array.isArray(body.input) ? "input" : "";
  let messages = [];
  if (listName) {
    messages = listName === "messages" ? body.messages : body.input;
  } else if (typeof body.input === "string") {
    pushPart(parts, "prompt", "prompt", "input", body.input);
  }

  messages.forEach((msg, i) => {
    if (!msg || typeof msg !== "object") {
      pushPart(parts, "unknown", "message", `${listName}[${i}]`, contentText(msg));
      return;
    }
    const role = typeof msg.role === "string" && msg.role ? msg.role : "unknown";
    const where = `${listName}[${i}] · ${role}${msg.tool_call_id ? ` · result for ${msg.tool_call_id}` : ""}`;
    pushPart(parts, role, "message", where, contentText(msg.content));
    for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      const name = call?.function?.name || call?.name || "";
      pushPart(parts, "tool", "tool_call", `${listName}[${i}] · tool_call${name ? ` ${name}` : ""}`, prettyArgs(call?.function?.arguments ?? call?.arguments));
    }
    if (msg.function_call) {
      const name = msg.function_call.name || "";
      pushPart(parts, "tool", "tool_call", `${listName}[${i}] · function_call${name ? ` ${name}` : ""}`, prettyArgs(msg.function_call.arguments));
    }
  });

  const tools = Array.isArray(body.tools) ? body.tools : Array.isArray(body.functions) ? body.functions : null;
  if (tools && tools.length > 0) {
    const label = Array.isArray(body.tools) ? "tools" : "functions";
    pushPart(parts, "tools", "tools", `${label} (${tools.length})`, JSON.stringify(tools, null, 2));
  }

  pushPart(parts, "prompt", "prompt", "prompt", contentText(body.prompt));

  if (parts.length === 0) return null;
  const totals = { parts: parts.length, chars: 0, words: 0, tokens: 0 };
  for (const p of parts) {
    totals.chars += p.chars;
    totals.words += p.words;
    totals.tokens += p.tokens;
  }
  return { parts, totals };
}

// ROLE_CLASSES maps a part role onto the styling hook used by the parts view.
const ROLE_CLASSES = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  tools: "tools",
  prompt: "prompt",
};

function statsText(p) {
  return `${p.chars.toLocaleString()} chars · ${p.words.toLocaleString()} words · ≈${p.tokens.toLocaleString()} tokens`;
}

// requestPartsHTML renders the parts view: one collapsible block per part with
// its own char/word/token counts, plus a totals line.
export function requestPartsHTML(requestParts) {
  if (!requestParts) return "";
  const { parts, totals } = requestParts;
  const blocks = parts
    .map((p) => {
      const roleClass = ROLE_CLASSES[p.role] || "other";
      return `
        <details class="capture-part" open>
          <summary class="capture-part-head">
            <span class="capture-part-role capture-part-role--${roleClass}">${escapeHtml(p.role)}</span>
            <span class="capture-part-label">${escapeHtml(p.label)}</span>
            <span class="capture-part-stats">${escapeHtml(statsText(p))}</span>
          </summary>
          <pre class="capture-pre capture-part-body">${escapeHtml(p.text)}</pre>
        </details>`;
    })
    .join("");
  return `
    <div class="capture-parts">
      <div class="capture-parts-totals">
        ${totals.parts} parts · ${totals.chars.toLocaleString()} chars · ${totals.words.toLocaleString()} words · ≈${totals.tokens.toLocaleString()} tokens
        <span class="capture-parts-note">token counts are approximate (chars ÷ 4)</span>
      </div>
      ${blocks}
    </div>`;
}

// requestPartsText renders the same parts as plain text for the Copy button.
export function requestPartsText(requestParts) {
  if (!requestParts) return "";
  return requestParts.parts
    .map((p) => `### ${p.label} [${statsText(p)}]\n${p.text}`)
    .join("\n\n");
}

// Parsing a capture body is not free for multi-megabyte prompts, so the last
// body string and its parts are memoized (the dialog re-renders on every tab
// switch and copy).
let partsCache = { raw: null, value: null };

function requestPartsFor(rawBody) {
  if (partsCache.raw === rawBody) return partsCache.value;
  const parsed = parseJsonObject(rawBody);
  partsCache = { raw: rawBody, value: parsed ? splitRequestParts(parsed) : null };
  return partsCache.value;
}

function getContentType(headers) {
  if (!headers) return "";
  return (headers["Content-Type"] || headers["content-type"] || "").toLowerCase();
}
function isImageCT(ct) {
  return ct.startsWith("image/");
}
function isTextCT(ct) {
  return (
    ct.startsWith("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/javascript")
  );
}
function imageDataUrl(body, ct) {
  const mime = ct.split(";")[0].trim();
  return `data:${mime};base64,${body}`;
}

function parseSSEChat(text) {
  const out = { reasoning: "", content: "" };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) continue;
    const data = trimmed.slice(6);
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) out.content += delta.content;
      if (delta?.reasoning_content) out.reasoning += delta.reasoning_content;
      if (delta?.reasoning) out.reasoning += delta.reasoning;
    } catch {
      /* skip */
    }
  }
  return out;
}

// Build a headers table HTML fragment
function headersTable(headers) {
  const rows = Object.entries(headers || {})
    .map(
      ([k, v]) => `
        <tr>
          <td class="capture-h-key">${escapeHtml(k)}</td>
          <td class="capture-h-val">${escapeHtml(String(v))}</td>
        </tr>`
    )
    .join("");
  return `<table class="capture-headers"><tbody>${rows}</tbody></table>`;
}

// Build body tabs HTML
function bodyTabsHTML(active, options) {
  return options
    .map(
      (opt) =>
        `<button class="capture-tab ${opt === active ? "capture-tab-active" : ""}" data-tab="${opt}">${opt[0].toUpperCase() + opt.slice(1)}</button>`
    )
    .join("");
}

export function CaptureDialogController() {
  const dlg = el(`<dialog class="capture-dlg"></dialog>`);
  document.body.appendChild(dlg);

  let state = {
    capture: null,
    reqBodyTab: "pretty",
    respBodyTab: "pretty",
    copiedReq: false,
    copiedResp: false,
  };

  function close() {
    if (dlg.open) dlg.close();
  }

  function render() {
    const c = state.capture;
    if (!c) {
      dlg.innerHTML = `
        <div class="capture-empty">
          <p class="capture-empty-title">Capture not found</p>
          <p class="capture-empty-sub">The capture may have expired or was never recorded.</p>
          <button class="btn" data-close>Close</button>
        </div>`;
      dlg.querySelector("[data-close]").addEventListener("click", close);
      return;
    }

    const reqCt = getContentType(c.req_headers);
    const respCt = getContentType(c.resp_headers);
    const isReqJson = reqCt.includes("json");
    const isRespImage = isImageCT(respCt);
    const isRespText = isTextCT(respCt);
    const isRespJson = respCt.includes("json");
    const isSSE = respCt.includes("text/event-stream");

    const reqBodyRaw = decodeBody(c.req_body);
    const reqBodyPretty = isReqJson ? formatJson(reqBodyRaw) : reqBodyRaw;
    // Split the request body into its role-tagged parts (system prompt, each
    // message, tool calls, tool schemas) so a multi-part request can be read
    // piece by piece instead of as one JSON blob.
    const reqParts = isReqJson ? requestPartsFor(reqBodyRaw) : null;
    const reqTab = state.reqBodyTab === "parts" && !reqParts ? "pretty" : state.reqBodyTab;
    const reqDisplay = reqTab === "raw" ? reqBodyRaw : reqBodyPretty;
    const reqCopyText = reqTab === "parts" && reqParts ? requestPartsText(reqParts) : reqDisplay;

    const respBodyRaw = decodeBody(c.resp_body);
    const respBodyPretty = isRespJson ? formatJson(respBodyRaw) : respBodyRaw;
    const sseChat = isSSE && respBodyRaw ? parseSSEChat(respBodyRaw) : null;
    const respDisplay = state.respBodyTab === "pretty" ? respBodyPretty : respBodyRaw;

    // Build body section
    function reqBodySection() {
      if (!reqBodyRaw) {
        return `<pre class="capture-pre capture-pre-empty">(empty)</pre>`;
      }
      const tabOptions = ["parts", "pretty", "raw"];
      if (!reqParts) tabOptions.shift();
      const tabsHTML = isReqJson
        ? `<div class="capture-tab-row">
             <div class="capture-tab-group">${bodyTabsHTML(reqTab, tabOptions)}</div>
             <button class="capture-tab" data-copy="req">${state.copiedReq ? "Copied!" : "Copy"}</button>
           </div>`
        : `<div class="capture-tab-row"><span></span><button class="capture-tab" data-copy="req">${state.copiedReq ? "Copied!" : "Copy"}</button></div>`;
      const body =
        reqTab === "parts" && reqParts
          ? requestPartsHTML(reqParts)
          : `<pre class="capture-pre">${escapeHtml(reqDisplay)}</pre>`;
      return `${tabsHTML}${body}`;
    }

    function respBodySection() {
      if (isRespImage && c.resp_body) {
        return `<div class="capture-image-wrap"><img src="${imageDataUrl(c.resp_body, respCt)}" alt="Response" /></div>`;
      }
      if (isSSE || isRespText) {
        const tabOptions = [];
        if (isSSE) tabOptions.push("chat");
        if (isRespJson) tabOptions.push("pretty");
        if (isSSE || isRespJson) tabOptions.push("raw");
        const tabsHTML =
          tabOptions.length > 0
            ? `<div class="capture-tab-row">
                 <div class="capture-tab-group">${bodyTabsHTML(state.respBodyTab, tabOptions)}</div>
                 <button class="capture-tab" data-copy="resp">${state.copiedResp ? "Copied!" : "Copy"}</button>
               </div>`
            : `<div class="capture-tab-row"><span></span><button class="capture-tab" data-copy="resp">${state.copiedResp ? "Copied!" : "Copy"}</button></div>`;

        let body;
        if (state.respBodyTab === "chat" && sseChat) {
          body = `<div class="capture-chat">`;
          if (sseChat.reasoning) {
            body += `<div class="capture-chat-label">Reasoning</div><pre class="capture-pre capture-pre-reasoning">${escapeHtml(sseChat.reasoning)}</pre>`;
            if (sseChat.content) body += `<div class="capture-chat-label">Response</div>`;
          }
          if (sseChat.content) body += `<pre class="capture-pre">${escapeHtml(sseChat.content)}</pre>`;
          if (!sseChat.reasoning && !sseChat.content) body += `<pre class="capture-pre">(empty)</pre>`;
          body += `</div>`;
        } else {
          body = `<pre class="capture-pre">${escapeHtml(respDisplay || "(empty)")}</pre>`;
        }
        return tabsHTML + body;
      }
      if (respBodyRaw) {
        return `<div class="capture-binary">(binary data - ${escapeHtml(respCt || "unknown content type")})</div>`;
      }
      return `<pre class="capture-pre">(empty)</pre>`;
    }

    dlg.innerHTML = `
      <div class="capture-shell">
        <div class="capture-head">
          <h2>Capture #${c.id + 1}${c.req_path ? ` <span class="capture-path">${escapeHtml(c.req_path)}</span>` : ""}</h2>
          <button class="capture-close" data-close>&times;</button>
        </div>
        <div class="capture-body">
          <details open>
            <summary class="capture-summary">Request Headers</summary>
            <div class="capture-scroll capture-scroll-short">${headersTable(c.req_headers)}</div>
          </details>
          <details open>
            <summary class="capture-summary">Request Body</summary>
            ${reqBodySection()}
          </details>
          <details open>
            <summary class="capture-summary">Response Headers</summary>
            <div class="capture-scroll capture-scroll-short">${headersTable(c.resp_headers)}</div>
          </details>
          <details open>
            <summary class="capture-summary">Response Body</summary>
            ${respBodySection()}
          </details>
        </div>
        <div class="capture-foot">
          <button class="btn" data-close>Close</button>
        </div>
      </div>
    `;

    dlg.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));
    dlg.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        // Determine if this is req or resp based on which section's tabs we're in
        // by checking parent context.
        const section = btn.closest("details");
        const summary = section?.querySelector(".capture-summary")?.textContent || "";
        if (summary.includes("Request")) state.reqBodyTab = tab;
        else state.respBodyTab = tab;
        render();
      });
    });
    dlg.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const which = btn.getAttribute("data-copy");
        let text;
        if (which === "req") text = reqCopyText;
        else {
          if (state.respBodyTab === "chat" && sseChat) {
            text = (sseChat.reasoning ? sseChat.reasoning + "\n\n" : "") + sseChat.content;
          } else {
            text = respDisplay;
          }
        }
        try {
          await navigator.clipboard.writeText(text);
          if (which === "req") {
            state.copiedReq = true;
            setTimeout(() => {
              state.copiedReq = false;
              render();
            }, 1500);
          } else {
            state.copiedResp = true;
            setTimeout(() => {
              state.copiedResp = false;
              render();
            }, 1500);
          }
          render();
        } catch {
          /* ignore */
        }
      });
    });
  }

  // defaultReqTab picks the landing tab for the request body: multi-part
  // prompts (system + messages + tool calls) open on the parts view, everything
  // else keeps the pretty JSON view.
  function defaultReqTab(capture) {
    const reqCt = getContentType(capture.req_headers);
    if (!reqCt.includes("json")) return "raw";
    const parts = requestPartsFor(decodeBody(capture.req_body));
    return parts && parts.parts.length > 1 ? "parts" : "pretty";
  }

  function open(capture) {
    state.capture = capture;
    // Reset tabs based on content types
    if (capture) {
      const respCt = getContentType(capture.resp_headers);
      state.reqBodyTab = defaultReqTab(capture);
      state.respBodyTab = respCt.includes("text/event-stream")
        ? "chat"
        : respCt.includes("json")
        ? "pretty"
        : "raw";
      state.copiedReq = false;
      state.copiedResp = false;
    }
    render();
    if (!dlg.open) dlg.showModal();
  }

  dlg.addEventListener("close", () => {
    state.capture = null;
  });

  // Close on Escape is automatic for <dialog>; clicking backdrop closes too:
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close();
  });

  return { open, close, destroy() {
    dlg.remove();
  }};
}
