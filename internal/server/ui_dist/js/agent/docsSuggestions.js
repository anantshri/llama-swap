// The questions offered on the empty Help page.
//
// Ported from lib/prompts/docsSuggestions.ts (upstream #1088). These are the
// first thing a new user reads, so they do double duty: they show that the
// agent answers questions about *this* server, and they name features most
// people never find. Every question must be answerable from `docs/kb/` or the
// running config — a suggestion the agent cannot answer teaches the reader
// that Help does not work, which is worse than offering nothing.

export const DOCS_SUGGESTIONS = [
  // general / setup
  "What can llama-swap do that I'm not using?",
  "What models are set up here?",
  "Which models stay loaded, and how much memory do they use?",
  "How can I keep several models ready at once?",
  "How can I switch between sets of models?",
  "Can one model name choose a different model each time?",
  "How do I unload a model after five minutes idle?",
  "A model won't start. How do I fix it?",
  "How do I use models on another computer?",
  "How do I load my most-used models at startup?",
  "How many requests can one model handle at once?",
  "How do I stop apps changing a model's settings?",
  "How do I avoid repeating a long command for every model?",
  "How do I tell apps a model can handle images or tools?",
  "My app fails while a model loads. What can I do?",
  "Can I save requests and responses while I troubleshoot?",
  "How do I connect an MCP app to this server?",
  "How do I reach this server safely from another network?",
  "How do I run llama-swap more safely in a container?",

  // model runtime: writing cmd
  "What is the smallest model setup to get started?",
  "My model starts but does not answer. What is wrong?",
  "Can I use a server other than llama-server?",
  "How do I set up tool use in llama-server?",
  "How do I make a model use certain GPUs?",
  "How do I send a different model name to the server behind llama-swap?",

  // model runtime: ttl and unloading
  "How does automatic model unloading work?",
  "How do I fully stop a Docker model container?",
  "How do I unload a model right now?",
  "Which models should always stay loaded?",

  // model runtime: capabilities and client feedback
  "Why does my model say it supports tools but not use them?",
  "How do I show model nicknames to apps?",
  "How can an app show that a model is still loading?",

  // troubleshooting
  "How do I make sure llama-swap knows when a model is ready?",
  "Where can I find why a model did not start?",
  "A model takes forever to start. Should I just wait longer?",

  // routing
  "How should I arrange models that can run together?",
  "How do I keep embeddings ready while swapping chat models?",
];

// How many suggestions the empty state offers at once.
export const SUGGESTION_COUNT = 4;

// Returns `count` suggestions picked at random from `pool`. Fisher-Yates —
// sorting by a random comparator is the tempting one-liner and it is not a
// uniform shuffle.
export function pickSuggestions(count = SUGGESTION_COUNT, pool = DOCS_SUGGESTIONS) {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.max(0, count));
}
