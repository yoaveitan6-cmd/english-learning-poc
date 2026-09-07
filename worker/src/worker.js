/**
 * English Learning POC — cross-device sync test Worker.
 *
 * Scope of this stage: prove that a vocabulary record saved on one device
 * shows up on another device. Nothing else.
 *
 * Identity model (single user, no login):
 *   The browser sends a long private sync key in the X-Sync-Key header.
 *   The Worker derives  owner_hash = HMAC-SHA256(SYNC_PEPPER, syncKey)  and
 *   uses only that hash to partition rows in D1. The raw key is never stored
 *   and never logged. SYNC_PEPPER is a Worker secret, so a leak of the D1
 *   contents alone does not allow offline brute-forcing of the sync key.
 *
 * Sync model:
 *   Record level only. POST upserts exactly one row, DELETE removes exactly
 *   one row. There is no "replace all" endpoint, so a device can never wipe
 *   records it does not know about. An update is rejected if it carries an
 *   older updatedAt than the row already stored (last write wins).
 *
 * Routes:
 *   GET    /health              -> no auth, liveness + config sanity
 *   GET    /vocabulary          -> all records for this sync-key identity
 *   POST   /vocabulary          -> create or update one record
 *   DELETE /vocabulary/:id      -> delete one record
 */

const MAX_TEXT_LEN = 500;   // per english/hebrew field
const MIN_KEY_LEN = 20;     // reject weak sync keys outright
const MAX_KEY_LEN = 512;
const MAX_ID_LEN = 64;
const MAX_BODY_BYTES = 8 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    // Preflight. The X-Sync-Key header makes every request non-simple, so the
    // browser sends OPTIONS before GET, POST and DELETE alike.
    if (request.method === "OPTIONS") {
      if (origin && !isAllowedOrigin(origin, env)) {
        return json({ error: "origin_not_allowed", origin: origin }, 403, { Vary: "Origin" });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (origin && !isAllowedOrigin(origin, env)) {
      return json(
        {
          error: "origin_not_allowed",
          origin: origin,
          hint: "Add this origin to ALLOWED_ORIGINS in wrangler.toml and redeploy."
        },
        403,
        { Vary: "Origin" }
      );
    }

    try {
      return await route(request, env, cors);
    } catch (err) {
      return json(
        { error: "internal_error", message: safeMessage(err) },
        500,
        cors
      );
    }
  }
};

/* ---------------- routing ---------------- */

async function route(request, env, cors) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/" || path === "/health") {
    if (method !== "GET") return methodNotAllowed(cors, "GET");
    return json(
      {
        ok: true,
        service: "english-learning-poc sync",
        stage: "sync-test-only",
        time: new Date().toISOString(),
        dbBound: !!env.DB,
        pepperConfigured: !!env.SYNC_PEPPER,
        allowedOriginCount: allowedOrigins(env).length
      },
      200,
      cors
    );
  }

  if (path === "/vocabulary") {
    if (method === "GET") return listVocabulary(request, env, cors);
    if (method === "POST") return upsertVocabulary(request, env, cors);
    return methodNotAllowed(cors, "GET, POST");
  }

  if (path.startsWith("/vocabulary/")) {
    if (method !== "DELETE") return methodNotAllowed(cors, "DELETE");
    let rawId = path.slice("/vocabulary/".length);
    try {
      rawId = decodeURIComponent(rawId);
    } catch (e) {
      return json({ error: "bad_id", message: "id is not valid percent-encoding" }, 400, cors);
    }
    return deleteVocabulary(request, env, cors, rawId);
  }

  return json({ error: "not_found", path: path }, 404, cors);
}

/* ---------------- handlers ---------------- */

async function listVocabulary(request, env, cors) {
  const auth = await authenticate(request, env);
  if (auth.error) return json(auth.error, auth.status, cors);
  if (!env.DB) return json(missingDb(), 500, cors);

  const result = await env.DB.prepare(
    "SELECT id, english, hebrew, createdAt, updatedAt " +
    "FROM vocabulary WHERE owner_hash = ? ORDER BY updatedAt DESC, id ASC"
  )
    .bind(auth.ownerHash)
    .all();

  const records = result.results || [];
  return json({ records: records, count: records.length, serverTime: Date.now() }, 200, cors);
}

async function upsertVocabulary(request, env, cors) {
  const auth = await authenticate(request, env);
  if (auth.error) return json(auth.error, auth.status, cors);
  if (!env.DB) return json(missingDb(), 500, cors);

  const parsed = await readJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);
  const body = parsed.value;

  const english = normalizeText(body.english);
  const hebrew = normalizeText(body.hebrew);

  if (!english) {
    return json({ error: "validation_failed", field: "english", message: "english is required" }, 400, cors);
  }
  if (english.length > MAX_TEXT_LEN) {
    return json(
      { error: "validation_failed", field: "english", message: "english exceeds " + MAX_TEXT_LEN + " characters" },
      400,
      cors
    );
  }
  if (hebrew.length > MAX_TEXT_LEN) {
    return json(
      { error: "validation_failed", field: "hebrew", message: "hebrew exceeds " + MAX_TEXT_LEN + " characters" },
      400,
      cors
    );
  }

  let id;
  if (body.id === undefined || body.id === null || body.id === "") {
    id = crypto.randomUUID();
  } else {
    if (typeof body.id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(body.id)) {
      return json(
        {
          error: "validation_failed",
          field: "id",
          message: "id must be 1-" + MAX_ID_LEN + " chars of A-Z a-z 0-9 . _ : -"
        },
        400,
        cors
      );
    }
    id = body.id;
  }

  const now = Date.now();
  const createdAt = clampTimestamp(body.createdAt, now);
  const updatedAt = clampTimestamp(body.updatedAt, now);

  // Record-level upsert. The WHERE guard makes this last-write-wins: a device
  // replaying a stale edit cannot overwrite a newer version of the same row,
  // and no other row is touched.
  const write = await env.DB.prepare(
    "INSERT INTO vocabulary (owner_hash, id, english, hebrew, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(owner_hash, id) DO UPDATE SET " +
    "  english = excluded.english, " +
    "  hebrew = excluded.hebrew, " +
    "  updatedAt = excluded.updatedAt " +
    "WHERE excluded.updatedAt >= vocabulary.updatedAt"
  )
    .bind(auth.ownerHash, id, english, hebrew, createdAt, updatedAt)
    .run();

  const applied = !!(write.meta && write.meta.changes > 0);

  const row = await env.DB.prepare(
    "SELECT id, english, hebrew, createdAt, updatedAt FROM vocabulary WHERE owner_hash = ? AND id = ?"
  )
    .bind(auth.ownerHash, id)
    .first();

  return json(
    {
      record: row || null,
      applied: applied,
      reason: applied ? "written" : "skipped_stale_updatedAt",
      serverTime: Date.now()
    },
    200,
    cors
  );
}

async function deleteVocabulary(request, env, cors, id) {
  const auth = await authenticate(request, env);
  if (auth.error) return json(auth.error, auth.status, cors);
  if (!env.DB) return json(missingDb(), 500, cors);

  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) {
    return json({ error: "bad_id", message: "id must be 1-" + MAX_ID_LEN + " characters" }, 400, cors);
  }

  const result = await env.DB.prepare(
    "DELETE FROM vocabulary WHERE owner_hash = ? AND id = ?"
  )
    .bind(auth.ownerHash, id)
    .run();

  const deleted = (result.meta && result.meta.changes) || 0;
  // Idempotent on purpose: deleting an already-deleted row is not an error,
  // which keeps two devices from fighting over the same delete.
  return json({ id: id, deleted: deleted, serverTime: Date.now() }, 200, cors);
}

/* ---------------- auth ---------------- */

async function authenticate(request, env) {
  if (!env.SYNC_PEPPER) {
    return {
      status: 500,
      error: {
        error: "server_not_configured",
        message: "SYNC_PEPPER secret is not set. Run: npx wrangler secret put SYNC_PEPPER"
      }
    };
  }

  const key = request.headers.get("X-Sync-Key");
  if (!key) {
    return {
      status: 401,
      error: { error: "missing_sync_key", message: "X-Sync-Key header is required" }
    };
  }
  if (key.length < MIN_KEY_LEN) {
    return {
      status: 401,
      error: {
        error: "sync_key_too_short",
        message: "Sync key must be at least " + MIN_KEY_LEN + " characters. Use the Generate button."
      }
    };
  }
  if (key.length > MAX_KEY_LEN) {
    return {
      status: 401,
      error: { error: "sync_key_too_long", message: "Sync key must be at most " + MAX_KEY_LEN + " characters" }
    };
  }

  return { ownerHash: await hashSyncKey(key, env.SYNC_PEPPER) };
}

async function hashSyncKey(syncKey, pepper) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(syncKey));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/* ---------------- CORS ---------------- */

function allowedOrigins(env) {
  const raw = (env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map(function (s) { return s.trim().replace(/\/+$/, ""); })
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  return allowedOrigins(env).indexOf(origin) !== -1;
}

function corsHeaders(origin, env) {
  const h = { Vary: "Origin" };
  if (origin && isAllowedOrigin(origin, env)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-Sync-Key";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

/* ---------------- helpers ---------------- */

async function readJsonBody(request) {
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

function normalizeText(v) {
  if (typeof v !== "string") return "";
  return v.trim().replace(/\s+/g, " ");
}

function clampTimestamp(v, now) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return now;
  // A device with a fast clock must not be able to win every future conflict.
  if (n > now + CLOCK_SKEW_MS) return now + CLOCK_SKEW_MS;
  return Math.floor(n);
}

function missingDb() {
  return {
    error: "server_not_configured",
    message: "D1 binding DB is missing. Check [[d1_databases]] binding = \"DB\" in wrangler.toml."
  };
}

function methodNotAllowed(cors, allow) {
  const headers = Object.assign({}, cors, { Allow: allow });
  return json({ error: "method_not_allowed", allow: allow }, 405, headers);
}

function safeMessage(err) {
  try {
    return String((err && err.message) || err);
  } catch (e) {
    return "(unreadable error)";
  }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      headers || {}
    )
  });
}
