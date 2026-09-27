// Agent work items: one collapsible "Work" section per assistant response
// holding the reasoning blocks and tool-call cards. The collapsed header shows
// stable counters (reasoning characters, duration, tool-call count) plus a
// spinner only while work is in progress — the label never switches with the
// current item, so the summary does not flicker while streaming.
// Ported from components/playground/AgentWork.svelte (upstream #1101).
import { el, escapeHtml } from "../dom.js";
import { friendlyToolName } from "../agent/agentTools.js";

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// One work item: { kind: "reasoning", content, durationMs, running }
//          or   { kind: "tool", name, label, args, content, ok, durationMs, running }
export function AgentWork({ workItems = [], onCollapse } = {}) {
  const root = el(`<div class="agent-work"></div>`);
  let expanded = false;

  function aggregate(items) {
    let reasoningChars = 0;
    let toolCalls = 0;
    let totalMs = 0;
    let working = false;
    for (const item of items) {
      if (item.kind === "reasoning") {
        reasoningChars += item.content.length;
        if (item.running) working = true;
      } else {
        toolCalls += 1;
        totalMs += item.durationMs || 0;
        if (item.running) working = true;
      }
    }
    return { reasoningChars, toolCalls, totalMs, working };
  }

  function render() {
    if (workItems.length === 0) {
      root.innerHTML = "";
      return;
    }
    const { reasoningChars, toolCalls, totalMs, working } = aggregate(workItems);
    const meta = `${reasoningChars.toLocaleString()} reasoning characters · ${formatDuration(totalMs)} · ${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}`;
    const items = workItems
      .map((item) => {
        if (item.kind === "reasoning") {
          const meta = item.running
            ? "thinking…"
            : `${item.content.length} chars${item.durationMs > 0 ? `, ${formatDuration(item.durationMs)}` : ""}`;
          return `
            <details class="agent-work-item agent-reasoning" ${item.running ? "open" : ""}>
              <summary class="agent-work-summary">
                <span class="agent-chevron" aria-hidden="true">▸</span>
                <span class="agent-work-label">Reasoning</span>
                <span class="muted agent-work-meta">${escapeHtml(meta)}</span>
              </summary>
              <div class="agent-work-body">${escapeHtml(item.content)}</div>
            </details>`;
        }
        const statusCls = item.ok === false ? "agent-tool--err" : item.ok === true ? "agent-tool--ok" : "agent-tool--running";
        const statusText = item.running ? "running…" : item.ok === false ? "failed" : item.ok === true ? formatDuration(item.durationMs) : "";
        return `
          <details class="agent-work-item agent-tool ${statusCls}" ${item.running ? "open" : ""}>
            <summary class="agent-work-summary">
              <span class="agent-chevron" aria-hidden="true">▸</span>
              <span class="agent-tool-icon" aria-hidden="true">🛠</span>
              <span class="agent-work-label">${escapeHtml(item.label || item.name)}</span>
              <span class="muted agent-work-meta">${escapeHtml(statusText)}</span>
            </summary>
            <div class="agent-work-body">
              ${item.args ? `<pre class="agent-tool-args">${escapeHtml(item.args)}</pre>` : ""}
              <div class="agent-tool-result">${escapeHtml(item.content || "")}</div>
            </div>
          </details>`;
      })
      .join("");
    // The counters stay identical whether work is running or done; only the
    // spinner appears and disappears, so the header never flickers.
    root.innerHTML = `
      <details class="agent-work-section" ${expanded ? "open" : ""}>
        <summary class="agent-work-summary agent-work-head">
          <span class="agent-chevron" aria-hidden="true">▸</span>
          <span class="agent-work-label">Work</span>
          <span class="muted agent-work-meta">${escapeHtml(meta)}</span>
          ${working ? `<span class="agent-work-spin" aria-hidden="true"></span>` : ""}
        </summary>
        <div class="agent-work-items">${items}</div>
      </details>`;
    const section = root.querySelector(".agent-work-section");
    // Track expansion via click (the toggle event fires asynchronously, so a
    // re-render between the click and the event would restore stale state).
    // The native toggle is the default action and runs after this listener,
    // so the state we want is the inverse of what is on the element now.
    section.querySelector(".agent-work-head").addEventListener("click", () => {
      expanded = !section.open;
    });
    if (onCollapse) onCollapse(expanded);
  }

  render();

  return {
    el: root,
    setItems(next) {
      workItems = next;
      render();
    },
    destroy() {},
  };
}

export { friendlyToolName };
