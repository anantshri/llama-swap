// Generation stats accumulate what a streamed chat turn reveals about its own
// cost: when the request started, when tokens started and stopped arriving,
// how many chunks came through in each phase, and whatever usage the backend
// reported.
//
// Chunks stand in for tokens until the backend says otherwise. llama.cpp
// streams one token per chunk (a multibyte character can span several), so
// the estimate is close and is replaced by the real count once usage arrives.
//
// Port of upstream's ui/src/lib/generationStats.ts (#1099) to the fork's
// vanilla-JS conventions: plain factory functions, no reactivity.

export function startTracking(now) {
  return {
    startedAt: now,
    firstTokenAt: undefined,
    lastTokenAt: undefined,
    // When the first answer chunk arrived, which ends the reasoning phase.
    answerStartedAt: undefined,
    reasoningChunks: 0,
    answerChunks: 0,
    usage: {},
    finishReason: undefined,
    // The user stopped the turn, so no backend finish_reason will arrive.
    cancelled: false,
  };
}

// Folds one streamed chunk into the tracker.
export function trackChunk(tracker, chunk, now) {
  const isAnswer = Boolean(chunk.content) || Boolean(chunk.tool_calls?.length);
  const isReasoning = !isAnswer && Boolean(chunk.reasoning_content);
  if (isAnswer || isReasoning) {
    if (tracker.firstTokenAt === undefined) tracker.firstTokenAt = now;
    tracker.lastTokenAt = now;
    if (isAnswer) {
      tracker.answerChunks += 1;
      if (tracker.answerStartedAt === undefined) tracker.answerStartedAt = now;
    } else {
      tracker.reasoningChunks += 1;
    }
  }
  if (chunk.usage) {
    // Later reports win field by field: /v1/messages sends input tokens on
    // message_start and output tokens on message_delta.
    tracker.usage = { ...tracker.usage, ...chunk.usage };
  }
  if (chunk.finish_reason) tracker.finishReason = chunk.finish_reason;
}

// Records that the user stopped the turn.
export function markCancelled(tracker) {
  tracker.cancelled = true;
}

function perSecond(tokens, ms) {
  if (tokens === undefined || ms === undefined || ms <= 0) return undefined;
  return tokens / (ms / 1000);
}

// The stats to display at time `now`. While the turn is still streaming the
// clocks run to `now`: the prompt clock until the first token arrives, the
// generation clock after it. Once the turn is done they stop at the last
// token.
export function currentStats(tracker, now, streaming) {
  const { usage, startedAt, firstTokenAt, lastTokenAt, reasoningChunks, answerChunks } = tracker;
  const chunks = reasoningChunks + answerChunks;
  const end = streaming ? now : lastTokenAt ?? now;

  const prompt = {
    approxTokens: usage.prompt_tokens === undefined,
    approxTimings: usage.prompt_ms === undefined,
    cached: usage.cached_tokens,
  };
  if (usage.prompt_tokens !== undefined) prompt.tokens = usage.prompt_tokens;
  if (usage.prompt_ms !== undefined) {
    prompt.ms = usage.prompt_ms;
  } else if (firstTokenAt !== undefined) {
    prompt.ms = firstTokenAt - startedAt;
  } else if (streaming) {
    prompt.ms = now - startedAt;
  }
  if (prompt.tokens !== undefined) {
    prompt.perSecond = perSecond(prompt.tokens - (usage.cached_tokens ?? 0), prompt.ms);
  }

  const generation = {
    approxTokens: usage.completion_tokens === undefined,
    approxTimings: usage.completion_ms === undefined,
  };
  if (usage.completion_tokens !== undefined) generation.tokens = usage.completion_tokens;
  else if (chunks > 0) generation.tokens = chunks;
  if (usage.completion_ms !== undefined) {
    generation.ms = usage.completion_ms;
  } else if (lastTokenAt !== undefined && firstTokenAt !== undefined) {
    generation.ms = lastTokenAt - firstTokenAt;
  } else if (streaming && firstTokenAt !== undefined) {
    generation.ms = now - firstTokenAt;
  }
  if (generation.tokens !== undefined) {
    generation.perSecond = perSecond(generation.tokens, generation.ms);
  }
  if (usage.draft_tokens !== undefined || usage.draft_accepted !== undefined) {
    generation.draft = { tokens: usage.draft_tokens, accepted: usage.draft_accepted };
  }
  return { prompt, generation, finishReason: tracker.finishReason, cancelled: tracker.cancelled };
}

function formatMs(ms) {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatRate(rate) {
  return rate >= 100 ? `${Math.round(rate)}` : rate.toFixed(1);
}

// One-line human form of currentStats() for the chat bubble, e.g.
// `prompt 128 tk (12 cached) in 210ms @ 610.0 tok/s · gen ~45 tk in 1.20s @ 38.2 tok/s · draft 4/5`.
// Empty when nothing has been measured yet.
export function formatStatsLine(stats) {
  if (!stats) return "";
  const parts = [];
  const p = stats.prompt;
  const g = stats.generation;
  if (p && (p.tokens !== undefined || p.ms !== undefined)) {
    let s = "prompt";
    if (p.tokens !== undefined) s += ` ${p.approxTokens ? "~" : ""}${p.tokens} tk`;
    if (p.cached) s += ` (${p.cached} cached)`;
    if (p.ms !== undefined) s += ` in ${formatMs(p.ms)}`;
    if (p.perSecond !== undefined) s += ` @ ${formatRate(p.perSecond)} tok/s`;
    parts.push(s);
  }
  if (g && (g.tokens !== undefined || g.ms !== undefined)) {
    let s = "gen";
    if (g.tokens !== undefined) s += ` ${g.approxTokens ? "~" : ""}${g.tokens} tk`;
    if (g.ms !== undefined) s += ` in ${formatMs(g.ms)}`;
    if (g.perSecond !== undefined) s += ` @ ${formatRate(g.perSecond)} tok/s`;
    if (g.draft && g.draft.tokens !== undefined) s += ` · draft ${g.draft.accepted ?? "?"}/${g.draft.tokens}`;
    parts.push(s);
  }
  if (stats.cancelled) parts.push("stopped");
  return parts.join(" · ");
}
