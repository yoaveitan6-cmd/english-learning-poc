-- ---------------------------------------------------------------------------
-- Migration 0005 — Device pairing.
--
-- ADDITIVE ONLY. No DROP, no DELETE, no ALTER, no re-CREATE of anything that
-- already exists. Every statement is CREATE ... IF NOT EXISTS, so applying it
-- twice is a no-op and applying it to the live database cannot lose a row.
--
-- Nothing here touches an existing table or changes what an existing
-- owner_hash means. A paired device is authenticated AS an existing owner_hash:
-- its credential row points at that owner, and every learning table keeps
-- being read and written under the very same owner_hash it always was.
--
-- No raw secret is ever stored:
--   credential_hash = HMAC-SHA256(SYNC_PEPPER, 'elp:device-key:v1:'   || deviceKey)
--   code_hash       = HMAC-SHA256(SYNC_PEPPER, 'elp:pairing-code:v1:' || code)
-- The context prefixes keep both distinct from owner_hash, which remains
-- HMAC-SHA256(SYNC_PEPPER, syncKey).
--
-- No User-Agent, IP address or other device fingerprint is stored. The only
-- descriptive field is an optional label the learner types.
--
-- Conventions carried over from 0001-0004:
--   owner_hash  = HMAC-SHA256(SYNC_PEPPER, syncKey), lowercase hex.
--   timestamps  = epoch milliseconds (INTEGER).
-- ---------------------------------------------------------------------------


-- A. One credential per paired device ---------------------------------------
-- device_id is a random opaque id, safe to show and to use in DELETE
-- /devices/:id. A revoked device keeps its row (revokedAt set) so the
-- management view can say what happened; authentication ignores it.
CREATE TABLE IF NOT EXISTS device_credential (
  device_id       TEXT    PRIMARY KEY,
  owner_hash      TEXT    NOT NULL,
  credential_hash TEXT    NOT NULL UNIQUE,
  label           TEXT    NOT NULL DEFAULT '',
  createdVia      TEXT    NOT NULL DEFAULT 'pairing',
  pairedBy        TEXT    NOT NULL DEFAULT '',         -- 'sync_key', or the device_id that issued the code
  createdAt       INTEGER NOT NULL,
  lastUsedAt      INTEGER,                             -- refreshed at most hourly
  revokedAt       INTEGER                              -- NULL while the device is connected
);

CREATE INDEX IF NOT EXISTS idx_device_credential_owner
  ON device_credential (owner_hash, createdAt);


-- B. Short-lived one-time pairing codes -------------------------------------
-- Keyed by the code's HMAC, so a claim is one indexed lookup and the raw code
-- never exists in D1. A row is live while consumedAt and cancelledAt are both
-- NULL and expiresAt is in the future; claiming sets consumedAt in a single
-- conditional UPDATE, which is what makes one-time use race-safe.
CREATE TABLE IF NOT EXISTS device_pairing_session (
  code_hash   TEXT    PRIMARY KEY,
  owner_hash  TEXT    NOT NULL,
  startedBy   TEXT    NOT NULL DEFAULT '',             -- 'sync_key', or the device_id that asked
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  consumedAt  INTEGER,
  cancelledAt INTEGER,
  device_id   TEXT                                     -- the credential the claim created
);

CREATE INDEX IF NOT EXISTS idx_device_pairing_session_owner
  ON device_pairing_session (owner_hash, expiresAt);


-- C. Failed-claim ceiling ---------------------------------------------------
-- One counter per 10-minute window, not per person: no IP or device is
-- recorded. It bounds how many guesses anyone can make against a live code.
CREATE TABLE IF NOT EXISTS pairing_claim_window (
  window_start INTEGER PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0
);
