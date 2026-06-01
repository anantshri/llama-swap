// Chat interface — scaffold placeholder. Implemented in Phase E (chat + markdown).
import { el } from "../dom.js";

export function ChatInterface() {
  const root = el(`
    <div class="pg-chat pg-chat-placeholder">
      <p class="muted">Chat — coming in Phase E (markdown + streaming).</p>
    </div>
  `);
  return { el: root, destroy() {} };
}
