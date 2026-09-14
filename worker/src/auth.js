/**
 * Identity for every authenticated route.
 *
 * Two credentials, one identity:
 *
 *   X-Device-Key  (preferred) a per-device secret issued once by
 *                 POST /pairing/claim. D1 stores only
 *                 HMAC-SHA256(SYNC_PEPPER, "elp:device-key:v1:" + key), mapped
 *                 to the owner_hash of the account that issued the pairing code.
 *                 Each device key can be revoked on its own.
 *
 *   X-Sync-Key    (legacy) the long shared key every device used to be typed
 *                 into. owner_hash = HMAC-SHA256(SYNC_PEPPER, syncKey), exactly
 *                 as it has always been computed — that derivation must never
 *                 change, or every existing row becomes unreachable.
 *
 * Both resolve to the same internal owner_hash, which is all the route modules
 * ever see. No route accepts an owner_hash from the client.
 *
 * When a request carries X-Device-Key, that header alone decides the identity:
 * a revoked or unknown device key is refused even if an X-Sync-Key is also
 * present, so a stale legacy key can never quietly stand in for a disconnected
 * device.
 *
 * The HMAC inputs for device keys and pairing codes carry distinct context
 * prefixes, so a credential hash can never equal an owner_hash and neither
 * hash can be replayed as the other.
 */

import { missingDb } from "./util.js";

export const MIN_KEY_LEN = 20;     // reject weak sync keys outright
export const MAX_KEY_LEN = 512;

/* ---- device keys ---- */
const DEVICE_KEY_PREFIX = "dk_";
const DEVICE_KEY_BYTES = 32;                          // 256 bits
export const DEVICE_KEY_PATTERN = /^dk_[A-Za-z0-9_-]{43}$/;
const DEVICE_KEY_CONTEXT = "elp:device-key:v1:";
/* lastUsedAt is shown in device management. It is refreshed at most hourly so
   an active device does not turn every read into a D1 write. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/* ---- pairing codes ---- */
/* No 0/O, 1/I/L: every character reads unambiguously off a screen. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;                 // 31^8 ≈ 2^39.6
const PAIRING_CODE_CONTEXT = "elp:pairing-code:v1:";

export async function authenticate(request, env) {
  if (!env.SYNC_PEPPER) {
    return {
      status: 500,
      error: {
        error: "server_not_configured",
        message: "SYNC_PEPPER secret is not set. Run: npx wrangler secret put SYNC_PEPPER"
      }
    };
  }

  const deviceKey = request.headers.get("X-Device-Key");
  if (deviceKey) return authenticateDevice(deviceKey, env);

  const key = request.headers.get("X-Sync-Key");
  if (!key) {
    return {
      status: 401,
      error: { error: "missing_sync_key", message: "This device is not connected. X-Device-Key or X-Sync-Key header is required" }
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

  return { ownerHash: await hashSyncKey(key, env.SYNC_PEPPER), method: "sync_key", deviceId: null };
}

/* One generic answer for a malformed, unknown or revoked device key, so the
   response never says which of the three it was. */
function invalidDeviceKey() {
  return {
    status: 401,
    error: {
      error: "invalid_device_key",
      message: "This device is no longer connected. Connect it again with a pairing code."
    }
  };
}

async function authenticateDevice(raw, env) {
  if (!DEVICE_KEY_PATTERN.test(raw)) return invalidDeviceKey();
  if (!env.DB) return { status: 500, error: missingDb() };

  const credentialHash = await hashDeviceKey(raw, env.SYNC_PEPPER);
  const row = await env.DB.prepare(
    "SELECT device_id, owner_hash, lastUsedAt FROM device_credential " +
    "WHERE credential_hash = ? AND revokedAt IS NULL"
  )
    .bind(credentialHash)
    .first();
  if (!row) return invalidDeviceKey();

  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    try {
      await env.DB.prepare(
        "UPDATE device_credential SET lastUsedAt = ? WHERE device_id = ? AND revokedAt IS NULL"
      )
        .bind(now, row.device_id)
        .run();
    } catch (e) {
      /* Bookkeeping only — it must never turn a valid request into a failure. */
    }
  }

  return { ownerHash: row.owner_hash, method: "device_key", deviceId: row.device_id };
}

/* ---------------- hashing ---------------- */

/** The original owner_hash derivation, byte for byte. Do not change. */
export async function hashSyncKey(syncKey, pepper) {
  return hmacHex(pepper, syncKey);
}

export async function hashDeviceKey(deviceKey, pepper) {
  return hmacHex(pepper, DEVICE_KEY_CONTEXT + deviceKey);
}

/** Expects a normalised code (see normalizePairingCode). */
export async function hashPairingCode(code, pepper) {
  return hmacHex(pepper, PAIRING_CODE_CONTEXT + code);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/* ---------------- secret generation ---------------- */

export function generateDeviceKey() {
  const bytes = new Uint8Array(DEVICE_KEY_BYTES);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return DEVICE_KEY_PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uniform over the alphabet: bytes that would bias the modulo are rejected. */
export function generatePairingCode() {
  const n = PAIRING_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < PAIRING_CODE_LENGTH) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < PAIRING_CODE_LENGTH; i++) {
      if (buf[i] < limit) out += PAIRING_CODE_ALPHABET[buf[i] % n];
    }
  }
  return out;
}

/** "AB7K3M9Q" -> "AB7K-3M9Q", the form shown to the learner. */
export function formatPairingCode(code) {
  return code.slice(0, 4) + "-" + code.slice(4);
}

/**
 * What the learner typed -> the canonical 8-character code, or null.
 * Case, spaces and hyphens are forgiven; anything outside the alphabet is not.
 */
export function normalizePairingCode(input) {
  if (typeof input !== "string" || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]+/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) {
    if (PAIRING_CODE_ALPHABET.indexOf(code[i]) === -1) return null;
  }
  return code;
}
