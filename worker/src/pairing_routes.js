/**
 * Device pairing and device management.
 *
 *   POST   /pairing/start    (authenticated)   -> a short one-time code for this owner
 *   POST   /pairing/cancel   (authenticated)   -> withdraw this owner's unclaimed code
 *   POST   /pairing/claim    (NOT authenticated) -> code in, a new device key out, once
 *   GET    /devices          (authenticated)   -> this owner's paired devices
 *   DELETE /devices/:id      (authenticated)   -> revoke one of them, immediately
 *
 * Pairing never creates an identity. A claimed code attaches a new device
 * credential to the owner_hash that started the pairing — the same rows, the
 * same plan, the same vocabulary — and nothing is copied anywhere.
 *
 * The claim endpoint necessarily runs before authentication, so its security
 * does not rest on CORS. It rests on:
 *   - entropy: 8 characters from a 31-character alphabet (~39.6 bits)
 *   - expiry: 10 minutes
 *   - one live code per owner: starting a new code cancels the previous one
 *   - one-time use: a single conditional UPDATE consumes the code, so of any
 *     number of concurrent claims exactly one can succeed
 *   - a bounded global ceiling on failed claims per 10-minute window, which
 *     caps online guessing at a few hundred attempts per code lifetime
 *   - only HMACs of codes and device keys are stored; the raw device key is
 *     returned exactly once, in the claim response, and never logged
 *   - every failure (unknown, expired, used, cancelled, malformed) gets the
 *     same response, so nothing is learned about nearby codes
 *
 * No route here calls Gemini.
 */

import { json, methodNotAllowed, missingDb, readJsonBody, readOptionalJsonBody, normalizeText } from "./util.js";
import {
  authenticate,
  generateDeviceKey,
  generatePairingCode,
  formatPairingCode,
  normalizePairingCode,
  hashDeviceKey,
  hashPairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH
} from "./auth.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const CLAIM_WINDOW_MS = 10 * 60 * 1000;
export const CLAIM_FAILURE_LIMIT = 100;
const MAX_LABEL_LEN = 40;
const MAX_DEVICES_LISTED = 100;
const START_ATTEMPTS = 5;

export function isPairingPath(path) {
  return path === "/pairing/start" ||
    path === "/pairing/cancel" ||
    path === "/pairing/claim" ||
    path === "/devices" ||
    /^\/devices\/[^/]+$/.test(path);
}

export async function routePairing(request, env, cors, path, method) {
  if (path === "/pairing/claim") {
    if (method !== "POST") return methodNotAllowed(cors, "POST");
    return claimPairing(request, env, cors);
  }

  const auth = await authenticate(request, env);
  if (auth.error) return json(auth.error, auth.status, cors);
  if (!env.DB) return json(missingDb(), 500, cors);

  if (path === "/pairing/start") {
    if (method !== "POST") return methodNotAllowed(cors, "POST");
    return startPairing(request, env, cors, auth);
  }
  if (path === "/pairing/cancel") {
    if (method !== "POST") return methodNotAllowed(cors, "POST");
    return cancelPairing(env, cors, auth);
  }
  if (path === "/devices") {
    if (method !== "GET") return methodNotAllowed(cors, "GET");
    return listDevices(env, cors, auth);
  }

  if (method !== "DELETE") return methodNotAllowed(cors, "DELETE");
  let id = path.slice("/devices/".length);
  try {
    id = decodeURIComponent(id);
  } catch (e) {
    return deviceNotFound(cors);
  }
  return revokeDevice(env, cors, auth, id);
}

/* ---------------- start / cancel ---------------- */

async function startPairing(request, env, cors, auth) {
  // The body is optional and nothing in it is used; reading it only keeps a
  // malformed request from being silently accepted.
  const parsed = await readOptionalJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);

  const now = Date.now();
  await cancelLiveCodes(env, auth.ownerHash, now);

  const expiresAt = now + PAIRING_TTL_MS;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const code = generatePairingCode();
    const codeHash = await hashPairingCode(code, env.SYNC_PEPPER);
    // A collision with any earlier row (live or long dead) just draws again.
    const write = await env.DB.prepare(
      "INSERT INTO device_pairing_session (code_hash, owner_hash, startedBy, createdAt, expiresAt) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(code_hash) DO NOTHING"
    )
      .bind(codeHash, auth.ownerHash, auth.deviceId || "sync_key", now, expiresAt)
      .run();
    if (write.meta && write.meta.changes === 1) {
      return json(
        {
          code: formatPairingCode(code),
          expiresAt: new Date(expiresAt).toISOString(),
          expiresInSeconds: Math.round(PAIRING_TTL_MS / 1000),
          serverTime: now
        },
        200,
        cors
      );
    }
  }
  return json({ error: "pairing_unavailable", message: "Could not create a pairing code. Try again." }, 503, cors);
}

async function cancelPairing(env, cors, auth) {
  const cancelled = await cancelLiveCodes(env, auth.ownerHash, Date.now());
  return json({ cancelled: cancelled, serverTime: Date.now() }, 200, cors);
}

async function cancelLiveCodes(env, ownerHash, now) {
  const result = await env.DB.prepare(
    "UPDATE device_pairing_session SET cancelledAt = ? " +
    "WHERE owner_hash = ? AND consumedAt IS NULL AND cancelledAt IS NULL AND expiresAt > ?"
  )
    .bind(now, ownerHash, now)
    .run();
  return (result.meta && result.meta.changes) || 0;
}

/* ---------------- claim ---------------- */

function invalidCode(cors) {
  return json(
    {
      error: "invalid_pairing_code",
      message: "That code did not work. Codes expire after 10 minutes and work once — create a new one on your connected device."
    },
    400,
    cors
  );
}

async function claimPairing(request, env, cors) {
  if (!env.SYNC_PEPPER) {
    return json(
      { error: "server_not_configured", message: "SYNC_PEPPER secret is not set. Run: npx wrangler secret put SYNC_PEPPER" },
      500,
      cors
    );
  }
  if (!env.DB) return json(missingDb(), 500, cors);

  const parsed = await readJsonBody(request);
  if (parsed.error) return invalidCode(cors);
  const body = parsed.value;

  const now = Date.now();
  const windowStart = now - (now % CLAIM_WINDOW_MS);
  const window = await env.DB.prepare(
    "SELECT failures FROM pairing_claim_window WHERE window_start = ?"
  )
    .bind(windowStart)
    .first();
  if (window && window.failures >= CLAIM_FAILURE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + CLAIM_WINDOW_MS - now) / 1000));
    return json(
      {
        error: "pairing_rate_limited",
        message: "Too many pairing attempts right now. Wait a few minutes, then create a new code and try again."
      },
      429,
      Object.assign({}, cors, { "Retry-After": String(retryAfter) })
    );
  }

  // A string that cannot be a code cannot match one either, so it is refused
  // without a lookup and without counting toward the ceiling.
  const code = normalizePairingCode(body.code);
  if (!code) return invalidCode(cors);

  const codeHash = await hashPairingCode(code, env.SYNC_PEPPER);
  const deviceId = crypto.randomUUID();

  // THE one-time guarantee. SQLite applies this conditional UPDATE atomically,
  // so however many claims race for the same code, exactly one sees
  // changes === 1. Tagging the row with this claim's own deviceId means the
  // SELECT below can only ever read back the row this request consumed.
  const consumed = await env.DB.prepare(
    "UPDATE device_pairing_session SET consumedAt = ?, device_id = ? " +
    "WHERE code_hash = ? AND consumedAt IS NULL AND cancelledAt IS NULL AND expiresAt > ?"
  )
    .bind(now, deviceId, codeHash, now)
    .run();

  if (!consumed.meta || consumed.meta.changes !== 1) {
    await recordClaimFailure(env, windowStart);
    return invalidCode(cors);
  }

  const session = await env.DB.prepare(
    "SELECT owner_hash, startedBy FROM device_pairing_session WHERE code_hash = ? AND device_id = ?"
  )
    .bind(codeHash, deviceId)
    .first();
  if (!session) {
    return json({ error: "pairing_failed", message: "Pairing could not be completed. Create a new code and try again." }, 500, cors);
  }

  const deviceKey = generateDeviceKey();
  const credentialHash = await hashDeviceKey(deviceKey, env.SYNC_PEPPER);
  const label = normalizeText(typeof body.label === "string" ? body.label : "").slice(0, MAX_LABEL_LEN);

  // owner_hash comes only from the consumed pairing row — never from the body.
  await env.DB.prepare(
    "INSERT INTO device_credential (device_id, owner_hash, credential_hash, label, createdVia, pairedBy, createdAt, lastUsedAt) " +
    "VALUES (?, ?, ?, ?, 'pairing', ?, ?, ?)"
  )
    .bind(deviceId, session.owner_hash, credentialHash, label, session.startedBy, now, now)
    .run();

  return json(
    {
      connected: true,
      // Returned exactly once. The server keeps only its HMAC.
      deviceKey: deviceKey,
      device: { id: deviceId, label: label, createdAt: now },
      serverTime: now
    },
    200,
    cors
  );
}

async function recordClaimFailure(env, windowStart) {
  try {
    await env.DB.prepare(
      "INSERT INTO pairing_claim_window (window_start, failures) VALUES (?, 1) " +
      "ON CONFLICT(window_start) DO UPDATE SET failures = failures + 1"
    )
      .bind(windowStart)
      .run();
  } catch (e) {
    /* The ceiling is defence in depth; entropy and expiry still hold without it. */
  }
}

/* ---------------- devices ---------------- */

async function listDevices(env, cors, auth) {
  const result = await env.DB.prepare(
    "SELECT device_id, label, createdAt, lastUsedAt, revokedAt FROM device_credential " +
    "WHERE owner_hash = ? ORDER BY createdAt DESC, device_id ASC LIMIT ?"
  )
    .bind(auth.ownerHash, MAX_DEVICES_LISTED)
    .all();

  // Deliberately an allowlist of fields: no credential hash, no owner_hash.
  const devices = (result.results || []).map(function (r) {
    return {
      id: r.device_id,
      label: r.label || "",
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt || null,
      revokedAt: r.revokedAt || null,
      active: !r.revokedAt,
      current: !!auth.deviceId && r.device_id === auth.deviceId
    };
  });

  return json(
    {
      authMethod: auth.method,
      currentDeviceId: auth.deviceId || null,
      devices: devices,
      activeCount: devices.filter(function (d) { return d.active; }).length,
      pairingCode: { length: PAIRING_CODE_LENGTH, alphabet: PAIRING_CODE_ALPHABET, ttlSeconds: Math.round(PAIRING_TTL_MS / 1000) },
      serverTime: Date.now()
    },
    200,
    cors
  );
}

function deviceNotFound(cors) {
  return json({ error: "device_not_found", message: "No such device on this account." }, 404, cors);
}

async function revokeDevice(env, cors, auth, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return deviceNotFound(cors);

  const now = Date.now();
  const write = await env.DB.prepare(
    "UPDATE device_credential SET revokedAt = ? WHERE owner_hash = ? AND device_id = ? AND revokedAt IS NULL"
  )
    .bind(now, auth.ownerHash, id)
    .run();

  if (!write.meta || write.meta.changes !== 1) {
    // Already revoked is not an error; another owner's device is "not found".
    const existing = await env.DB.prepare(
      "SELECT revokedAt FROM device_credential WHERE owner_hash = ? AND device_id = ?"
    )
      .bind(auth.ownerHash, id)
      .first();
    if (!existing) return deviceNotFound(cors);
    return json({ id: id, revoked: true, alreadyRevoked: true, current: id === auth.deviceId, serverTime: now }, 200, cors);
  }

  return json({ id: id, revoked: true, alreadyRevoked: false, current: id === auth.deviceId, serverTime: now }, 200, cors);
}
