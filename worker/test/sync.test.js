/**
 * Regression tests for the sync stage. These describe behaviour that already
 * worked before the AI endpoint was added, so a failure here means the AI work
 * broke cross-device sync.
 */
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { makeEnv, req, TEST_ORIGIN, TEST_SYNC_KEY } from "./helpers.js";

async function call(request, env) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, text, body };
}

test("health reports configuration without leaking values", async () => {
  const env = makeEnv();
  const { res, body, text } = await call(req("GET", "/health", { key: null }), env);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dbBound, true);
  assert.equal(body.pepperConfigured, true);
  assert.equal(body.geminiConfigured, true);
  assert.ok(!text.includes(env.SYNC_PEPPER));
  assert.ok(!text.includes(env.GEMINI_API_KEY));
});

test("GET /vocabulary without a sync key is 401", async () => {
  const { res, body } = await call(req("GET", "/vocabulary", { key: null }), makeEnv());
  assert.equal(res.status, 401);
  assert.equal(body.error, "missing_sync_key");
});

test("GET /vocabulary with a short sync key is 401", async () => {
  const { res, body } = await call(req("GET", "/vocabulary", { key: "short" }), makeEnv());
  assert.equal(res.status, 401);
  assert.equal(body.error, "sync_key_too_short");
});

test("POST then GET round-trips one record", async () => {
  const env = makeEnv();
  const post = await call(
    req("POST", "/vocabulary", { body: { english: "apple", hebrew: "tapuach" } }),
    env
  );
  assert.equal(post.res.status, 200);
  assert.equal(post.body.applied, true);
  assert.equal(post.body.record.english, "apple");

  const get = await call(req("GET", "/vocabulary"), env);
  assert.equal(get.res.status, 200);
  assert.equal(get.body.count, 1);
  assert.equal(get.body.records[0].hebrew, "tapuach");
});

test("a record is invisible to a different sync key", async () => {
  const env = makeEnv();
  await call(req("POST", "/vocabulary", { body: { english: "apple" } }), env);
  const other = await call(req("GET", "/vocabulary", { key: "z".repeat(32) }), env);
  assert.equal(other.body.count, 0);
});

test("POST rejects an empty english field", async () => {
  const { res, body } = await call(req("POST", "/vocabulary", { body: { english: "  " } }), makeEnv());
  assert.equal(res.status, 400);
  assert.equal(body.error, "validation_failed");
  assert.equal(body.field, "english");
});

test("a stale updatedAt does not overwrite a newer row", async () => {
  const env = makeEnv();
  const now = Date.now();
  await call(
    req("POST", "/vocabulary", { body: { id: "w1", english: "new", updatedAt: now } }),
    env
  );
  const stale = await call(
    req("POST", "/vocabulary", { body: { id: "w1", english: "old", updatedAt: now - 60000 } }),
    env
  );
  assert.equal(stale.body.applied, false);
  assert.equal(stale.body.reason, "skipped_stale_updatedAt");
  assert.equal(stale.body.record.english, "new");
});

test("DELETE removes one record and is idempotent", async () => {
  const env = makeEnv();
  await call(req("POST", "/vocabulary", { body: { id: "w1", english: "apple" } }), env);

  const first = await call(req("DELETE", "/vocabulary/w1"), env);
  assert.equal(first.res.status, 200);
  assert.equal(first.body.deleted, 1);

  const second = await call(req("DELETE", "/vocabulary/w1"), env);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.deleted, 0);
});

test("an allowed origin gets CORS headers, a foreign origin is refused", async () => {
  const env = makeEnv();
  const ok = await worker.fetch(req("GET", "/vocabulary", { origin: TEST_ORIGIN }), env);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);

  const bad = await call(req("GET", "/vocabulary", { origin: "https://evil.example" }), env);
  assert.equal(bad.res.status, 403);
  assert.equal(bad.body.error, "origin_not_allowed");
});

test("preflight from an allowed origin advertises X-Sync-Key", async () => {
  const res = await worker.fetch(
    req("OPTIONS", "/vocabulary", { key: null, origin: TEST_ORIGIN }),
    makeEnv()
  );
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-Sync-Key/);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("the raw sync key never appears in any response", async () => {
  const env = makeEnv();
  const post = await call(req("POST", "/vocabulary", { body: { english: "apple" } }), env);
  const get = await call(req("GET", "/vocabulary"), env);
  assert.ok(!post.text.includes(TEST_SYNC_KEY));
  assert.ok(!get.text.includes(TEST_SYNC_KEY));
  for (const row of env.DB.rows.values()) {
    assert.ok(!JSON.stringify(row).includes(TEST_SYNC_KEY));
  }
});

test("an unknown path is 404", async () => {
  const { res, body } = await call(req("GET", "/nope"), makeEnv());
  assert.equal(res.status, 404);
  assert.equal(body.error, "not_found");
});
