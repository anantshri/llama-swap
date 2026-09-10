// Per-feature streaming/activity flags, ported from stores/playgroundActivity.ts.
import { observable, derived } from "./store.js";

const chatStreaming = observable(false);
const imageGenerating = observable(false);
const speechGenerating = observable(false);
const audioTranscribing = observable(false);
const rerankLoading = observable(false);
const concurrencyRunning = observable(false);
const docsStreaming = observable(false);

export const playgroundActivity = derived(
  [chatStreaming, imageGenerating, speechGenerating, audioTranscribing, rerankLoading, concurrencyRunning, docsStreaming],
  (chat, image, speech, audio, rerank, concurrency, docs) =>
    chat || image || speech || audio || rerank || concurrency || docs
);

export const playgroundStores = {
  chatStreaming,
  imageGenerating,
  speechGenerating,
  audioTranscribing,
  rerankLoading,
  concurrencyRunning,
  docsStreaming,
};

// Shared playground task lifecycle: flips the activity store, supplies an
// AbortSignal for the cancel buttons, swallows AbortError, and settles the
// store when the work ends. Returns a thenable exposing abort() and, once
// settled, .error (the caught error's message, or null on success/abort).
export function runTask(store, fn) {
  const abortController = new AbortController();
  const run = (async () => {
    let error = null;
    store.set(true);
    try {
      await fn(abortController.signal);
    } catch (err) {
      if (err.name !== "AbortError") error = err.message || "An error occurred";
    } finally {
      store.set(false);
    }
    return { error };
  })();
  run.abort = () => abortController.abort();
  return run;
}
