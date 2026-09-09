/**
 * Shared Gemini transport.
 *
 * This is the HTTP half of talking to Google — retries, deadlines, upstream
 * error mapping, pulling the model's JSON out of a generateContent envelope,
 * and redacting secrets on the way out. It was extracted unchanged from
 * worker.js when the Vocabulary slice needed the same behaviour for four more
 * call sites; worker.js's /ai/correct now calls into it and behaves exactly as
 * it did before (test/ai.test.js is the proof).
 *
 * What this file deliberately never does:
 *   - it never enables Search, grounding, tools, or any paid-only feature.
 *     Every request is plain generateContent with a response schema.
 *   - it never puts GEMINI_API_KEY in a URL, a response, or a log. The key is
 *     read from env at the moment of the fetch and sent in a header.
 *   - it never decides anything pedagogical. Callers own prompts and schemas.
 */

/**
 * Model routing.
 *
 * Two roles, because the two kinds of work have very different volumes and the
 * free tier's per-day request limits differ by an order of magnitude:
 *
 *   correction  gemini-3.8-flash        ~20 requests/day on the free tier.
 *               One sentence at a time, entirely learner-initiated, so a
 *               handful of calls a day. /ai/correct stays here.
 *
 *   vocabulary  gemini-3.1-flash-lite   ~500 requests/day on the free tier.
 *               The Vocabulary slice's four purposes. Even batched, a daily
 *               session plus manual adds is several calls a day, every day —
 *               and it shares nothing with the correction budget. Twenty a day
 *               is not a budget a daily lesson can live inside.
 *
 *   sentencePractice  gemini-3.1-flash-lite   same reasoning as vocabulary: a
 *               daily grammar session (one batched generation call, plus at
 *               most a couple of free-text evaluation calls) is a volume the
 *               correction budget cannot absorb. Kept as its own named role,
 *               not folded into `vocabulary`, so the two purposes can be
 *               retargeted independently later even though they currently
 *               point at the same model.
 *
 * All three are plain generateContent with a response schema; Flash-Lite is
 * documented as supporting structured outputs, which every prompt here relies
 * on. None is a paid-only model and nothing about billing changes.
 *
 * The env overrides exist so a model can be moved without a code change if a
 * name is retired. None is set in wrangler.toml, so the defaults apply.
 */
export const MODELS = {
  correction: "gemini-3.8-flash",
  vocabulary: "gemini-3.1-flash-lite",
  sentencePractice: "gemini-3.1-flash-lite"
};

export const GEMINI_MODEL = MODELS.correction;
export const GEMINI_VOCAB_MODEL = MODELS.vocabulary;

export const GEMINI_TIMEOUT_MS = 30000;   // overall deadline for all attempts together
export const GEMINI_MAX_ATTEMPTS = 3;     // only a 503 "high demand" is retried
export const GEMINI_RETRY_DELAYS_MS = [700, 1800];
export const MAX_AI_FIELD_LEN = 1000;

const ENV_OVERRIDE_BY_ROLE = {
  correction: "GEMINI_MODEL",
  vocabulary: "GEMINI_VOCAB_MODEL",
  sentencePractice: "GEMINI_SENTENCE_MODEL"
};

/** The model for one role. Callers name the role; only this file names models. */
export function modelFor(env, role) {
  const envKey = ENV_OVERRIDE_BY_ROLE[role] || "GEMINI_MODEL";
  const override = env[envKey];
  const m = typeof override === "string" ? override.trim() : "";
  return m || MODELS[role] || MODELS.correction;
}

/** The correction role. Kept as its own name because /ai/correct reads it. */
export function geminiModel(env) {
  return modelFor(env, "correction");
}

/** The vocabulary role — every /vocab/ purpose routes through here. */
export function vocabularyModel(env) {
  return modelFor(env, "vocabulary");
}

/** The sentence-practice role — both its Gemini purposes route through here. */
export function sentencePracticeModel(env) {
  return modelFor(env, "sentencePractice");
}

/**
 * One structured-output generateContent request.
 *
 * A 503 UNAVAILABLE ("this model is experiencing high demand") is common on the
 * free tier and clears within a second or two, so it — and only it — is retried
 * a couple of times inside one browser request. A 429 is never retried: that is
 * the quota talking, and hammering it would only burn more of it. All attempts
 * share one deadline, so the learner never waits longer than the budget.
 *
 * Returns { data } on success, or { status, error } with a message that is safe
 * to hand to the browser.
 */
export async function callGemini(opts) {
  const env = opts.env;
  const model = opts.model;
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const payload = {
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: opts.userText }] }],
    generationConfig: {
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.2,
      topP: 0.9,
      maxOutputTokens: typeof opts.maxOutputTokens === "number" ? opts.maxOutputTokens : 4096,
      responseMimeType: "application/json",
      responseSchema: opts.schema
    }
  };

  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : GEMINI_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);

  try {
    let last = null;
    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const waited = await delay(GEMINI_RETRY_DELAYS_MS[attempt - 1], controller.signal);
        if (!waited) break;   // the overall deadline ran out while backing off
      }
      last = await attemptGemini(url, payload, env, controller.signal, timeoutMs);
      if (!last.retryable) return last;
    }
    return last;
  } finally {
    clearTimeout(timer);
  }
}

/* One HTTP round trip. `retryable` marks the transient-overload case only. */
async function attemptGemini(url, payload, env, signal, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header, not ?key= — a query string is far easier to leak into a log.
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify(payload),
      signal: signal
    });
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      status: 504,
      error: {
        error: aborted ? "ai_timeout" : "ai_unreachable",
        message: aborted
          ? "The AI request took longer than " + Math.round(timeoutMs / 1000) + " seconds and was cancelled. Try again."
          : "Could not reach the AI service. Try again in a moment."
      }
    };
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    return {
      status: 502,
      error: { error: "ai_upstream_error", message: "Could not read the AI service response." }
    };
  }

  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }

  if (!res.ok) {
    return {
      status: mapUpstreamStatus(res.status),
      error: upstreamError(res.status, body),
      retryable: res.status === 503
    };
  }
  if (!body) {
    return {
      status: 502,
      error: { error: "ai_bad_output", message: "The AI service returned a response that was not JSON." }
    };
  }
  return { data: body };
}

/* Resolves true after ms, or false as soon as the shared deadline aborts. */
function delay(ms, signal) {
  return new Promise(function (resolve) {
    if (signal && signal.aborted) { resolve(false); return; }
    const t = setTimeout(function () { resolve(true); }, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        function () { clearTimeout(t); resolve(false); },
        { once: true }
      );
    }
  });
}

export function mapUpstreamStatus(status) {
  if (status === 429) return 429;
  if (status === 401 || status === 403) return 502;
  return 502;
}

/**
 * Never forwards the upstream body. Only a curated user-facing message plus the
 * upstream HTTP status and, when Google supplied one, its short reason code —
 * enough to diagnose "wrong model" or "billing required" without echoing
 * internal payloads. Every string is redacted again before it is sent.
 */
export function upstreamError(status, body) {
  const err = body && body.error ? body.error : null;
  const reason = err && typeof err.status === "string" ? err.status : "";
  const detail = err && typeof err.message === "string" ? err.message.slice(0, 300) : "";

  if (status === 429) {
    return {
      error: "ai_rate_limited",
      message: "The AI free-tier quota is exhausted for now. Wait a minute and try again.",
      upstreamStatus: status,
      upstreamReason: reason || "RESOURCE_EXHAUSTED",
      upstreamDetail: detail
    };
  }
  if (status === 401 || status === 403) {
    return {
      error: "ai_not_authorized",
      message: "The AI service rejected this Worker's credentials or refused the request. This needs a human check in Google AI Studio.",
      upstreamStatus: status,
      upstreamReason: reason,
      upstreamDetail: detail
    };
  }
  if (status === 404) {
    return {
      error: "ai_model_unavailable",
      message: "The configured AI model was not found for this API version or key.",
      upstreamStatus: status,
      upstreamReason: reason,
      upstreamDetail: detail
    };
  }
  if (status === 400) {
    return {
      error: "ai_request_rejected",
      message: "The AI service rejected the request.",
      upstreamStatus: status,
      upstreamReason: reason,
      upstreamDetail: detail
    };
  }
  return {
    error: "ai_upstream_error",
    message: "The AI service is temporarily unavailable. Try again in a moment.",
    upstreamStatus: status,
    upstreamReason: reason,
    upstreamDetail: detail
  };
}

/**
 * Pulls the model's JSON object out of a generateContent envelope.
 *
 * Everything here is a refusal to trust the upstream shape: a blocked prompt, a
 * truncated answer, a missing candidate, a code fence, prose instead of JSON —
 * each becomes a named error rather than an exception or, worse, a half-parsed
 * object reaching the learner.
 *
 * Returns { value } or { error }.
 */
export function extractModelJson(body) {
  const blocked = body && body.promptFeedback && body.promptFeedback.blockReason;
  if (blocked) {
    return {
      error: {
        error: "ai_blocked",
        message: "The AI service declined to analyse this sentence.",
        reason: String(blocked).slice(0, 60)
      }
    };
  }

  const candidates = Array.isArray(body && body.candidates) ? body.candidates : [];
  const candidate = candidates[0];
  if (!candidate) {
    return {
      error: { error: "ai_bad_output", message: "The AI service returned no answer for this sentence." }
    };
  }

  const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
  if (finish === "MAX_TOKENS") {
    return {
      error: {
        error: "ai_output_truncated",
        message: "The AI answer was cut off before it was complete. Try a shorter sentence."
      }
    };
  }
  if (finish && finish !== "STOP") {
    return {
      error: {
        error: "ai_blocked",
        message: "The AI service stopped before producing an answer.",
        reason: finish.slice(0, 60)
      }
    };
  }

  const parts = (candidate.content && Array.isArray(candidate.content.parts))
    ? candidate.content.parts
    : [];
  let text = "";
  for (let i = 0; i < parts.length; i++) {
    // Reasoning parts (thought: true) carry no answer content; skip them.
    if (parts[i] && typeof parts[i].text === "string" && parts[i].thought !== true) {
      text += parts[i].text;
    }
  }
  text = stripCodeFence(text.trim());
  if (!text) {
    return {
      error: { error: "ai_bad_output", message: "The AI service returned an empty answer." }
    };
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return {
      error: { error: "ai_bad_output", message: "The AI answer was not valid JSON." }
    };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      error: { error: "ai_bad_output", message: "The AI answer was not a JSON object." }
    };
  }
  return { value: obj };
}

export function stripCodeFence(s) {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  return m ? m[1].trim() : s;
}

/** Trims and caps one string field that came back from the model. */
export function aiString(v, max) {
  if (typeof v !== "string") return "";
  const limit = typeof max === "number" ? max : MAX_AI_FIELD_LEN;
  return v.trim().slice(0, limit);
}

/**
 * Belt and braces: even though no code path puts GEMINI_API_KEY into a
 * response, every AI error object passes through here before it is serialised,
 * so a future edit cannot leak the key through an error string.
 */
export function redactObject(obj, env) {
  const key = env && typeof env.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY : "";
  const pepper = env && typeof env.SYNC_PEPPER === "string" ? env.SYNC_PEPPER : "";
  if (!key && !pepper) return obj;

  const walk = function (v) {
    if (typeof v === "string") {
      let out = v;
      if (key && key.length >= 8) out = out.split(key).join("[redacted]");
      if (pepper && pepper.length >= 8) out = out.split(pepper).join("[redacted]");
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const copy = {};
      for (const k of Object.keys(v)) copy[k] = walk(v[k]);
      return copy;
    }
    return v;
  };
  return walk(obj);
}
