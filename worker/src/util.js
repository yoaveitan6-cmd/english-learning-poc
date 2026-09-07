/**
 * Small HTTP/validation helpers shared by worker.js and learning.js.
 *
 * These were originally private to worker.js. They moved here unchanged when
 * the learning-engine routes were added, so both route files use one
 * implementation of "how this Worker answers" rather than two that can drift.
 * Nothing about their behaviour changed.
 */

export const MAX_BODY_BYTES = 8 * 1024;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function json(obj, status, headers) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      headers || {}
    )
  });
}

export function methodNotAllowed(cors, allow) {
  const headers = Object.assign({}, cors, { Allow: allow });
  return json({ error: "method_not_allowed", allow: allow }, 405, headers);
}

export function missingDb() {
  return {
    error: "server_not_configured",
    message: "D1 binding DB is missing. Check [[d1_databases]] binding = \"DB\" in wrangler.toml."
  };
}

export function safeMessage(err) {
  try {
    return String((err && err.message) || err);
  } catch (e) {
    return "(unreadable error)";
  }
}

export async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch (e) {
    return { error: { error: "bad_body", message: "could not read request body" } };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { error: { error: "body_too_large", message: "body exceeds " + MAX_BODY_BYTES + " bytes" } };
  }
  if (!text) {
    return { error: { error: "bad_body", message: "request body is empty; expected JSON" } };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: { error: "bad_json", message: safeMessage(e) } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: { error: "bad_json", message: "body must be a JSON object" } };
  }
  return { value: value };
}

/** An optional JSON body: an empty body is `{}` rather than an error. */
export async function readOptionalJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch (e) {
    return { error: { error: "bad_body", message: "could not read request body" } };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { error: { error: "body_too_large", message: "body exceeds " + MAX_BODY_BYTES + " bytes" } };
  }
  if (!text.trim()) return { value: {} };
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: { error: "bad_json", message: safeMessage(e) } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: { error: "bad_json", message: "body must be a JSON object" } };
  }
  return { value: value };
}

export function normalizeText(v) {
  if (typeof v !== "string") return "";
  return v.trim().replace(/\s+/g, " ");
}

export function clampTimestamp(v, now) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return now;
  // A device with a fast clock must not be able to win every future conflict.
  if (n > now + CLOCK_SKEW_MS) return now + CLOCK_SKEW_MS;
  return Math.floor(n);
}

export function clampInt(v, lo, hi, fallback) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Validation helper for the lowercase slugs used as learning-target ids. */
export function isSlug(v, maxLen) {
  if (typeof v !== "string") return false;
  const limit = Number(maxLen) || 40;
  if (v.length < 1 || v.length > limit) return false;
  return /^[a-z0-9][a-z0-9_]*$/.test(v);
}
