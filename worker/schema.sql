-- English Learning POC — cross-device sync test schema (Cloudflare D1)
--
-- owner_hash is HMAC-SHA256(SYNC_PEPPER, syncKey) as lowercase hex.
-- The raw sync key is NEVER stored here.
--
-- Timestamps are epoch milliseconds (INTEGER) so last-write-wins comparison
-- is unambiguous across devices and timezones.

CREATE TABLE IF NOT EXISTS vocabulary (
  owner_hash TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  english    TEXT    NOT NULL,
  hebrew     TEXT    NOT NULL DEFAULT '',
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, id)
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_owner_updated
  ON vocabulary (owner_hash, updatedAt DESC);
