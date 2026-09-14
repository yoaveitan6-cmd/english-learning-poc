/**
 * Device pairing, per-device credentials and revocation, over the real Worker
 * with a real SQLite database running the real migrations.
 *
 * What this file exists to prove:
 *   - only an authenticated device (legacy sync key OR device key) can start
 *     pairing, and the code it gets is short, unambiguous and high-entropy
 *   - a code works exactly once, only before it expires, and every kind of
 *     failure looks the same from outside
 *   - a claimed device authenticates as the EXACT owner_hash that started the
 *     pairing, and sees and changes that owner's real state — nothing is
 *     copied, no second identity is created
 *   - no raw pairing code and no raw device key ever reaches D1 or a response
 *     it should not be in
 *   - owners stay isolated, a revoked key stops working immediately, and the
 *     legacy X-Sync-Key path is unchanged
 *   - none of it makes a network call
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import worker from "../src/worker.js";
import {
  makeEnv,
  req,
  stubFetch,
  stubGeminiByPurpose,
  jsonResponse,
  geminiOk,
  sentenceExerciseBatch,
  SAMPLE_SENTENCE_EVAL,
  SAMPLE_FEEDBACK,
  TEST_ORIGIN,
  TEST_SYNC_KEY,
  TEST_PEPPER,
  TEST_GEMINI_KEY
} from "./helpers.js";
import {
  generatePairingCode,
  generateDeviceKey,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  DEVICE_KEY_PATTERN
} from "../src/auth.js";
import { CLAIM_FAILURE_LIMIT, CLAIM_WINDOW_MS, PAIRING_TTL_MS } from "../src/pairing_routes.js";

const OTHER_KEY = "z".repeat(40);
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/* Independent re-implementations with node:crypto, so the tests check the
   derivations themselves rather than trusting the Worker's own helpers. */
const ownerHashOf = (key) => createHmac("sha256", TEST_PEPPER).update(key).digest("hex");
const credentialHashOf = (dk) => createHmac("sha256", TEST_PEPPER).update("elp:device-key:v1:" + dk).digest("hex");
const codeHashOf = (code) => createHmac("sha256", TEST_PEPPER).update("elp:pairing-code:v1:" + code.replace("-", "")).digest("hex");

async function call(request, env) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, text, body };
}

function asDevice(method, path, deviceKey, opts = {}) {
  return req(method, path, { ...opts, key: null, headers: { ...(opts.headers || {}), "X-Device-Key": deviceKey } });
}

async function startCode(env, { key = TEST_SYNC_KEY, deviceKey } = {}) {
  const r = await call(deviceKey ? asDevice("POST", "/pairing/start", deviceKey) : req("POST", "/pairing/start", { key }), env);
  assert.equal(r.res.status, 200, r.text);
  return r.body;
}

function claim(env, code, extra = {}, opts = {}) {
  return call(req("POST", "/pairing/claim", { key: null, ...opts, body: { code, ...extra } }), env);
}

async function pairNewDevice(env, opts = {}) {
  const started = await startCode(env, opts);
  const c = await claim(env, started.code, opts.label ? { label: opts.label } : {});
  assert.equal(c.res.status, 200, c.text);
  return { code: started.code, deviceKey: c.body.deviceKey, deviceId: c.body.device.id, claim: c };
}

/** Every row of every table, as one string — for "is this secret anywhere?". */
function dumpAll(env) {
  const tables = env.DB.query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  return tables.map((t) => JSON.stringify(env.DB.query('SELECT * FROM "' + t + '"'))).join("\n");
}

async function atOffset(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

async function withNoNetwork(fn) {
  const stub = stubFetch(() => { throw new Error("unexpected network call"); });
  try {
    return await fn(stub);
  } finally {
    stub.restore();
  }
}

/* ---------------- pairing start ---------------- */

test("starting pairing requires authentication", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const none = await call(req("POST", "/pairing/start", { key: null }), env);
    assert.equal(none.res.status, 401);
    const weak = await call(req("POST", "/pairing/start", { key: "short" }), env);
    assert.equal(weak.res.status, 401);
    const bogusDevice = await call(asDevice("POST", "/pairing/start", generateDeviceKey()), env);
    assert.equal(bogusDevice.res.status, 401);
    assert.equal(bogusDevice.body.error, "invalid_device_key");
  });
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM device_pairing_session")[0].n, 0);
});

test("a legacy sync-key device can start pairing and gets a short, well-formed code", async () => {
  const env = makeEnv();
  const before = Date.now();
  const started = await startCode(env);
  assert.match(started.code, CODE_RE);
  assert.equal(started.expiresInSeconds, 600);
  const expires = Date.parse(started.expiresAt);
  assert.ok(expires >= before + PAIRING_TTL_MS && expires <= Date.now() + PAIRING_TTL_MS, "expires ~10 minutes from now");
  // The response carries exactly what the UI needs, and no identity.
  assert.deepEqual(Object.keys(started).sort(), ["code", "expiresAt", "expiresInSeconds", "serverTime"]);
  assert.ok(!JSON.stringify(started).includes(ownerHashOf(TEST_SYNC_KEY)));
});

test("a device-key device can start pairing too, and its code joins the same owner", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const c = await pairNewDevice(env, { deviceKey: b.deviceKey });
  const rows = env.DB.query("SELECT device_id, owner_hash, pairedBy FROM device_credential ORDER BY createdAt, device_id");
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.owner_hash, ownerHashOf(TEST_SYNC_KEY));
  assert.equal(rows.find((r) => r.device_id === c.deviceId).pairedBy, b.deviceId);
  assert.equal(rows.find((r) => r.device_id === b.deviceId).pairedBy, "sync_key");
});

test("pairing codes use only the unambiguous alphabet, uniformly, with ~39.6 bits of entropy", () => {
  assert.equal(PAIRING_CODE_ALPHABET.length, 31);
  assert.equal(PAIRING_CODE_LENGTH, 8);
  for (const ambiguous of ["0", "O", "1", "I", "L"]) {
    assert.ok(!PAIRING_CODE_ALPHABET.includes(ambiguous), ambiguous + " must not be in the alphabet");
  }
  const bits = PAIRING_CODE_LENGTH * Math.log2(PAIRING_CODE_ALPHABET.length);
  assert.ok(bits > 39.5, "entropy " + bits.toFixed(2) + " bits");

  const counts = {};
  const seen = new Set();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const code = generatePairingCode();
    assert.equal(code.length, 8);
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    seen.add(code);
    for (const ch of code) counts[ch] = (counts[ch] || 0) + 1;
  }
  assert.equal(seen.size, N, "4000 random codes should not collide");
  // Every character is used, and none is wildly over- or under-represented
  // (expected ~1032 each; a biased modulo would skew the low characters).
  assert.equal(Object.keys(counts).length, 31);
  for (const ch of PAIRING_CODE_ALPHABET) {
    assert.ok(counts[ch] > 800 && counts[ch] < 1270, ch + " appeared " + counts[ch] + " times");
  }
});

test("the raw pairing code is never stored — only its HMAC", async () => {
  const env = makeEnv();
  const started = await startCode(env);
  const raw = started.code.replace("-", "");
  const all = dumpAll(env);
  assert.ok(!all.includes(started.code), "hyphenated code must not be in D1");
  assert.ok(!all.includes(raw), "bare code must not be in D1");
  const rows = env.DB.query("SELECT code_hash, owner_hash, expiresAt, consumedAt FROM device_pairing_session");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, codeHashOf(started.code));
  assert.equal(rows[0].owner_hash, ownerHashOf(TEST_SYNC_KEY));
  assert.equal(rows[0].consumedAt, null);
});

test("a new code replaces this owner's previous unclaimed code; cancel withdraws it", async () => {
  const env = makeEnv();
  const first = await startCode(env);
  const second = await startCode(env);
  assert.notEqual(first.code, second.code);
  assert.equal((await claim(env, first.code)).res.status, 400, "the replaced code no longer works");

  const cancelled = await call(req("POST", "/pairing/cancel"), env);
  assert.equal(cancelled.res.status, 200);
  assert.equal(cancelled.body.cancelled, 1);
  assert.equal((await claim(env, second.code)).res.status, 400, "a cancelled code no longer works");

  // Another owner's code is not affected by my new code or my cancel.
  const theirs = await startCode(env, { key: OTHER_KEY });
  await startCode(env);
  await call(req("POST", "/pairing/cancel"), env);
  assert.equal((await claim(env, theirs.code)).res.status, 200);
});

/* ---------------- pairing claim ---------------- */

test("a valid code creates a device credential for the SAME owner, returned once", async () => {
  const env = makeEnv();
  const started = await startCode(env);
  const c = await claim(env, started.code, { label: "  My   iPhone  " });
  assert.equal(c.res.status, 200, c.text);
  assert.equal(c.body.connected, true);
  assert.match(c.body.deviceKey, DEVICE_KEY_PATTERN);
  assert.equal(c.body.device.label, "My iPhone");
  assert.deepEqual(Object.keys(c.body).sort(), ["connected", "device", "deviceKey", "serverTime"]);

  const rows = env.DB.query("SELECT * FROM device_credential");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_hash, ownerHashOf(TEST_SYNC_KEY));
  assert.equal(rows[0].device_id, c.body.device.id);
  assert.equal(rows[0].credential_hash, credentialHashOf(c.body.deviceKey));
  assert.equal(rows[0].revokedAt, null);

  // The claim response is the only place the raw key ever appears.
  const devices = await call(req("GET", "/devices"), env);
  assert.ok(!devices.text.includes(c.body.deviceKey));
});

test("a claimed device key authenticates as the exact same owner and sees the same identity", async () => {
  const env = makeEnv();
  const aProfile = await call(req("GET", "/learner"), env);
  assert.equal(aProfile.body.createdNow, true);

  const b = await pairNewDevice(env);
  const bProfile = await call(asDevice("GET", "/learner", b.deviceKey), env);
  assert.equal(bProfile.res.status, 200, bProfile.text);
  assert.equal(bProfile.body.createdNow, false, "B must not get a fresh profile — it IS owner A");
  assert.deepEqual(bProfile.body.profile, aProfile.body.profile);

  const owners = env.DB.query("SELECT owner_hash FROM learner_profile");
  assert.equal(owners.length, 1, "pairing must never create a second learning identity");
  assert.equal(owners[0].owner_hash, ownerHashOf(TEST_SYNC_KEY));
});

test("the same code cannot be claimed twice", async () => {
  const env = makeEnv();
  const started = await startCode(env);
  const first = await claim(env, started.code);
  assert.equal(first.res.status, 200);
  const second = await claim(env, started.code);
  assert.equal(second.res.status, 400);
  assert.equal(second.body.error, "invalid_pairing_code");
  assert.ok(!("deviceKey" in second.body));
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM device_credential")[0].n, 1);
});

test("concurrent claims of one code: exactly one wins", async () => {
  const env = makeEnv();
  const started = await startCode(env);
  const results = await Promise.all(Array.from({ length: 12 }, () => claim(env, started.code)));
  const winners = results.filter((r) => r.res.status === 200);
  const losers = results.filter((r) => r.res.status === 400);
  assert.equal(winners.length, 1, "one-time use must hold under concurrency");
  assert.equal(losers.length, 11);
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM device_credential")[0].n, 1);
  const session = env.DB.query("SELECT device_id FROM device_pairing_session")[0];
  assert.equal(session.device_id, winners[0].body.device.id);
});

test("an expired code fails, and a code just inside its lifetime still works", async () => {
  const env = makeEnv();
  const late = await startCode(env);
  const lateClaim = await atOffset(PAIRING_TTL_MS + 1000, () => claim(env, late.code));
  assert.equal(lateClaim.res.status, 400);
  assert.equal(lateClaim.body.error, "invalid_pairing_code");

  const env2 = makeEnv();
  const onTime = await startCode(env2);
  const onTimeClaim = await atOffset(PAIRING_TTL_MS - 5000, () => claim(env2, onTime.code));
  assert.equal(onTimeClaim.res.status, 200, onTimeClaim.text);
});

test("every failure looks identical: unknown, nearby, expired, used, cancelled, malformed", async () => {
  const env = makeEnv();
  const used = await startCode(env, { key: OTHER_KEY });
  await claim(env, used.code);
  const expired = await startCode(env, { key: "e".repeat(40) });
  const cancelled = await startCode(env, { key: "c".repeat(40) });
  await call(req("POST", "/pairing/cancel", { key: "c".repeat(40) }), env);
  const live = await startCode(env);

  // One character away from a live code.
  const raw = live.code.replace("-", "");
  const swap = raw[7] === "2" ? "3" : "2";
  const nearby = raw.slice(0, 7) + swap;

  const attempts = [
    await claim(env, nearby),
    await claim(env, "ZZZZ-ZZZZ"),
    await claim(env, used.code),
    await atOffset(PAIRING_TTL_MS + 1000, () => claim(env, expired.code)),
    await claim(env, cancelled.code),
    await claim(env, "0O1I-LLLL"),
    await claim(env, "too short"),
    await claim(env, 12345678),
    await call(req("POST", "/pairing/claim", { key: null, body: "not json" }), env),
    await call(req("POST", "/pairing/claim", { key: null, body: {} }), env)
  ];
  const shapes = attempts.map((a) => a.res.status + " " + JSON.stringify(a.body));
  for (const s of shapes) assert.equal(s, shapes[0], "all failures must be indistinguishable");
  assert.equal(attempts[0].res.status, 400);
  for (const a of attempts) {
    assert.ok(!a.text.includes(live.code) && !a.text.includes(raw));
  }
  // And the live code is still claimable — probing near it did not burn it.
  assert.equal((await claim(env, live.code)).res.status, 200);
});

test("typing is forgiving: lowercase, spaces and a missing hyphen still work", async () => {
  const env = makeEnv();
  const started = await startCode(env);
  const typed = " " + started.code.toLowerCase().replace("-", " ") + " ";
  const c = await claim(env, typed);
  assert.equal(c.res.status, 200, c.text);
  assert.equal(normalizePairingCode("ab7k-3m9q"), "AB7K3M9Q");
  assert.equal(normalizePairingCode("AB7K3M9"), null);
  assert.equal(normalizePairingCode("AB0K-3M9Q"), null, "0 is not in the alphabet");
});

test("the raw device key is never stored anywhere in D1", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  // Use it a bit so every write path that could possibly record it has run.
  await call(asDevice("POST", "/daily-plan", b.deviceKey, { body: {} }), env);
  await call(asDevice("GET", "/devices", b.deviceKey), env);
  const all = dumpAll(env);
  assert.ok(!all.includes(b.deviceKey), "raw device key found in D1");
  assert.ok(!all.includes(b.deviceKey.slice(3)), "raw device key body found in D1");
  assert.ok(!all.includes(TEST_SYNC_KEY), "raw sync key found in D1");
});

test("a claim cannot choose its owner, its device id, or be steered by auth headers", async () => {
  const env = makeEnv();
  await call(req("GET", "/learner", { key: OTHER_KEY }), env);
  const victim = ownerHashOf(OTHER_KEY);

  const started = await startCode(env);
  const c = await claim(
    env,
    started.code,
    { owner_hash: victim, ownerHash: victim, deviceId: "chosen-id", device_id: "chosen-id" },
    { key: OTHER_KEY, headers: { "X-Device-Key": generateDeviceKey() } }
  );
  assert.equal(c.res.status, 200, c.text);
  assert.notEqual(c.body.device.id, "chosen-id");
  const row = env.DB.query("SELECT owner_hash FROM device_credential WHERE device_id = ?", c.body.device.id)[0];
  assert.equal(row.owner_hash, ownerHashOf(TEST_SYNC_KEY), "the owner comes only from the pairing session");
});

test("failed claims hit a bounded ceiling per window, then recover", async () => {
  const env = makeEnv();
  // Pin time to the start of a window so the whole test stays inside it.
  const now = Date.now();
  const windowStart = now - (now % CLAIM_WINDOW_MS) + CLAIM_WINDOW_MS;
  const offset = windowStart + 1000 - now;

  await atOffset(offset, async () => {
    const started = await startCode(env);
    env.DB.exec(
      "INSERT INTO pairing_claim_window (window_start, failures) VALUES (" + windowStart + ", " + (CLAIM_FAILURE_LIMIT - 1) + ")"
    );
    const lastAllowed = await claim(env, "ZZZZ-ZZZZ");
    assert.equal(lastAllowed.res.status, 400);

    const blocked = await claim(env, started.code);
    assert.equal(blocked.res.status, 429);
    assert.equal(blocked.body.error, "pairing_rate_limited");
    assert.ok(Number(blocked.res.headers.get("Retry-After")) > 0);
    assert.ok(!blocked.text.includes(started.code.replace("-", "")));
    assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM device_credential")[0].n, 0);
  });

  // The next window is open again — but by then this code has also expired,
  // so a fresh one is needed, exactly as the message says.
  await atOffset(offset + CLAIM_WINDOW_MS, async () => {
    const fresh = await startCode(env);
    const ok = await claim(env, fresh.code);
    assert.equal(ok.res.status, 200, ok.text);
  });
});

/* ---------------- device auth across the product ---------------- */

test("X-Device-Key reaches Today's Plan and sees the exact plan device A created", async () => {
  const env = makeEnv();
  const aPlan = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  assert.equal(aPlan.res.status, 200);
  const b = await pairNewDevice(env);

  const bGet = await call(asDevice("GET", "/daily-plan", b.deviceKey), env);
  assert.equal(bGet.res.status, 200, bGet.text);
  assert.deepEqual(bGet.body.plan, aPlan.body.plan);

  const bPost = await call(asDevice("POST", "/daily-plan", b.deviceKey, { body: { mode: "standard" } }), env);
  assert.equal(bPost.body.created, false, "B must get A's stored plan, not build its own");
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM daily_plan")[0].n, 1);
});

test("a change made on device B is what device A sees, and vice versa", async () => {
  const env = makeEnv();
  const plan = (await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env)).body.plan;
  const b = await pairNewDevice(env);
  const speaking = plan.activities.find((a) => a.type === "speaking");

  const done = await call(
    asDevice("POST", "/daily-plan/activity/" + encodeURIComponent(speaking.activityId) + "/complete", b.deviceKey, { body: {} }),
    env
  );
  assert.equal(done.res.status, 200, done.text);

  const aView = await call(req("GET", "/daily-plan"), env);
  assert.equal(aView.body.plan.activities.find((a) => a.type === "speaking").status, "complete");

  // And the other direction: A adds a word, B sees it.
  await call(req("POST", "/vocabulary", { body: { id: "from-a", english: "pairing", hebrew: "צימוד" } }), env);
  const bWords = await call(asDevice("GET", "/vocabulary", b.deviceKey), env);
  assert.deepEqual(bWords.body.records.map((r) => r.id), ["from-a"]);
});

test("X-Device-Key reaches Vocabulary: library, manual add and sessions share one owner", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  await withNoNetwork(async (stub) => {
    const added = await call(req("POST", "/vocab/items", { body: { term: "figure out", hebrew: "להבין" } }), env);
    assert.equal(added.res.status, 200, added.text);
    const bAdded = await call(asDevice("POST", "/vocab/items", b.deviceKey, { body: { term: "come across", hebrew: "להיתקל" } }), env);
    assert.equal(bAdded.res.status, 200, bAdded.text);

    const aLib = await call(req("GET", "/vocab/library"), env);
    const bLib = await call(asDevice("GET", "/vocab/library", b.deviceKey), env);
    assert.deepEqual(bLib.body.items, aLib.body.items);
    assert.deepEqual(aLib.body.items.map((i) => i.english).sort(), ["come across", "figure out"]);

    const bSession = await call(asDevice("GET", "/vocab/session", b.deviceKey), env);
    assert.equal(bSession.res.status, 200, bSession.text);
    assert.equal(stub.calls.length, 0);
  });
  const owners = new Set(env.DB.query("SELECT owner_hash FROM vocabulary").map((r) => r.owner_hash));
  assert.deepEqual([...owners], [ownerHashOf(TEST_SYNC_KEY)], "no duplicated vocabulary under a new owner");
});

test("X-Device-Key reaches Sentence Practice: same session, answers and durable summary", async () => {
  const env = makeEnv();
  const g = stubGeminiByPurpose({
    sentenceGeneration: (payload, user) => jsonResponse(200, geminiOk(sentenceExerciseBatch(user))),
    sentenceEval: () => jsonResponse(200, geminiOk(SAMPLE_SENTENCE_EVAL))
  });
  try {
    await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
    const aStart = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(aStart.res.status, 200, aStart.text);
    const b = await pairNewDevice(env);

    const bGet = await call(asDevice("GET", "/sentence-practice/session", b.deviceKey), env);
    assert.deepEqual(bGet.body.session, aStart.body.session, "B reads the stored session");
    const bPost = await call(asDevice("POST", "/sentence-practice/session", b.deviceKey, { body: {} }), env);
    assert.equal(bPost.body.created, false);
    assert.equal(g.counts.sentenceGeneration, 1, "a paired device must not regenerate the session");

    // B answers everything and completes it.
    let latest = bGet.body.session;
    for (;;) {
      const pending = latest.exercises.filter((e) => !e.attempted);
      if (!pending.length) break;
      for (const ex of pending) {
        const stored = JSON.parse(env.DB.query(
          "SELECT answer FROM sentence_practice_exercise WHERE session_key = ? AND exercise_id = ?",
          latest.sessionKey, ex.exerciseId
        )[0].answer);
        const answer = stored.correctOption || stored.canonicalAnswer || "I have finished this exercise correctly.";
        const r = await call(asDevice("POST", "/sentence-practice/session/answer", b.deviceKey, { body: { exerciseId: ex.exerciseId, answer } }), env);
        assert.equal(r.res.status, 200, r.text);
        latest = r.body.session;
      }
    }
    const done = await call(asDevice("POST", "/sentence-practice/session/complete", b.deviceKey, { body: {} }), env);
    assert.equal(done.res.status, 200, done.text);

    const aView = await call(req("GET", "/sentence-practice/session"), env);
    assert.equal(aView.body.session.status, "complete");
    assert.deepEqual(aView.body.session.summary, done.body.summary, "A sees B's durable summary");
    const aPlan = await call(req("GET", "/daily-plan"), env);
    assert.equal(aPlan.body.plan.activities.find((a) => a.type === "sentence_practice").status, "complete");
  } finally {
    g.restore();
  }
});

test("X-Device-Key reaches the AI correction POC, accounted to the same owner, key not forwarded", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const stub = stubFetch(async () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)));
  try {
    const r = await call(asDevice("POST", "/ai/correct", b.deviceKey, { body: { sentence: "Yesterday I go to the store." } }), env);
    assert.equal(r.res.status, 200, r.text);
    assert.equal(stub.calls.length, 1);
    assert.ok(!JSON.stringify(stub.calls[0].init.headers).includes(b.deviceKey));
    assert.ok(!stub.calls[0].init.body.includes(b.deviceKey));
  } finally {
    stub.restore();
  }
  const usage = env.DB.query("SELECT owner_hash FROM ai_usage_daily");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].owner_hash, ownerHashOf(TEST_SYNC_KEY));
});

test("a wrong, malformed or empty device key never reaches the owner", async () => {
  const env = makeEnv();
  await call(req("POST", "/vocabulary", { body: { english: "secret word" } }), env);
  const b = await pairNewDevice(env);

  const tampered = b.deviceKey.slice(0, -1) + (b.deviceKey.endsWith("A") ? "B" : "A");
  const cases = [generateDeviceKey(), tampered, "dk_short", "not-a-device-key-at-all-but-long-enough", b.deviceKey + "x"];
  const bodies = [];
  for (const bad of cases) {
    const r = await call(asDevice("GET", "/vocabulary", bad), env);
    assert.equal(r.res.status, 401, "accepted: " + bad);
    assert.ok(!r.text.includes("secret word"));
    bodies.push(JSON.stringify(r.body));
  }
  for (const body of bodies) assert.equal(body, bodies[0], "device-key failures must be indistinguishable");
});

test("device key is authoritative: a bad device key is refused even beside a valid sync key", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const both = await call(req("GET", "/learner", { key: TEST_SYNC_KEY, headers: { "X-Device-Key": generateDeviceKey() } }), env);
  assert.equal(both.res.status, 401, "a stale/invalid device key must not silently fall back to the sync key");

  // A valid device key beside a DIFFERENT owner's sync key still means the device's owner.
  await call(req("POST", "/vocabulary", { body: { id: "mine", english: "mine" } }), env);
  const mixed = await call(req("GET", "/vocabulary", { key: OTHER_KEY, headers: { "X-Device-Key": b.deviceKey } }), env);
  assert.deepEqual(mixed.body.records.map((r) => r.id), ["mine"]);
});

test("owners stay isolated: another owner's paired device sees and controls nothing of mine", async () => {
  const env = makeEnv();
  await call(req("POST", "/vocabulary", { body: { id: "a-word", english: "only A" } }), env);
  await call(req("POST", "/daily-plan", { body: {} }), env);
  const b = await pairNewDevice(env);
  const d = await pairNewDevice(env, { key: OTHER_KEY });

  const dWords = await call(asDevice("GET", "/vocabulary", d.deviceKey), env);
  assert.equal(dWords.body.count, 0);
  const dPlan = await call(asDevice("GET", "/daily-plan", d.deviceKey), env);
  assert.equal(dPlan.body.plan, null);

  const dDevices = await call(asDevice("GET", "/devices", d.deviceKey), env);
  assert.deepEqual(dDevices.body.devices.map((x) => x.id), [d.deviceId]);

  const revokeMine = await call(asDevice("DELETE", "/devices/" + b.deviceId, d.deviceKey), env);
  assert.equal(revokeMine.res.status, 404);
  const revokeViaSync = await call(req("DELETE", "/devices/" + b.deviceId, { key: OTHER_KEY }), env);
  assert.equal(revokeViaSync.res.status, 404);
  assert.equal((await call(asDevice("GET", "/vocabulary", b.deviceKey), env)).res.status, 200, "B still connected");

  // A pairing started by owner C only ever produces owner C devices.
  assert.equal(
    env.DB.query("SELECT owner_hash FROM device_credential WHERE device_id = ?", d.deviceId)[0].owner_hash,
    ownerHashOf(OTHER_KEY)
  );
});

test("legacy X-Sync-Key keeps working and owner_hash is still HMAC(pepper, syncKey)", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  await call(req("POST", "/vocabulary", { body: { id: "legacy", english: "still works" } }), env);
  const rows = env.DB.query("SELECT owner_hash FROM vocabulary");
  assert.equal(rows[0].owner_hash, ownerHashOf(TEST_SYNC_KEY));
  const legacy = await call(req("GET", "/vocabulary"), env);
  assert.equal(legacy.body.count, 1);
  // Pairing did not change anything for the legacy device.
  assert.equal((await call(req("GET", "/learner"), env)).res.status, 200);
  assert.equal((await call(asDevice("GET", "/vocabulary", b.deviceKey), env)).body.count, 1);
});

/* ---------------- device management / revocation ---------------- */

test("GET /devices lists this owner's devices with an allowlist of safe fields", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env, { label: "iPhone" });
  const fromLegacy = await call(req("GET", "/devices"), env);
  assert.equal(fromLegacy.res.status, 200);
  assert.equal(fromLegacy.body.authMethod, "sync_key");
  assert.equal(fromLegacy.body.currentDeviceId, null);
  assert.equal(fromLegacy.body.activeCount, 1);
  const dev = fromLegacy.body.devices[0];
  assert.deepEqual(Object.keys(dev).sort(), ["active", "createdAt", "current", "id", "label", "lastUsedAt", "revokedAt"]);
  assert.equal(dev.label, "iPhone");
  assert.equal(dev.current, false);

  const fromB = await call(asDevice("GET", "/devices", b.deviceKey), env);
  assert.equal(fromB.body.authMethod, "device_key");
  assert.equal(fromB.body.currentDeviceId, b.deviceId);
  assert.equal(fromB.body.devices[0].current, true);

  const credentialHash = credentialHashOf(b.deviceKey);
  for (const r of [fromLegacy, fromB]) {
    assert.ok(!r.text.includes(credentialHash));
    assert.ok(!r.text.includes(b.deviceKey));
    assert.ok(!r.text.includes(ownerHashOf(TEST_SYNC_KEY)));
    assert.ok(!r.text.includes(TEST_SYNC_KEY));
  }
});

test("a revoked device key stops authenticating immediately, and revoking is idempotent", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const c = await pairNewDevice(env);
  assert.equal((await call(asDevice("GET", "/daily-plan", b.deviceKey), env)).res.status, 200);

  const revoke = await call(asDevice("DELETE", "/devices/" + b.deviceId, c.deviceKey), env);
  assert.equal(revoke.res.status, 200, revoke.text);
  assert.equal(revoke.body.revoked, true);
  assert.equal(revoke.body.alreadyRevoked, false);

  for (const [m, p] of [["GET", "/daily-plan"], ["GET", "/vocab/library"], ["GET", "/sentence-practice/session"], ["POST", "/pairing/start"], ["GET", "/devices"]]) {
    const r = await call(asDevice(m, p, b.deviceKey), env);
    assert.equal(r.res.status, 401, m + " " + p + " after revoke");
    assert.equal(r.body.error, "invalid_device_key");
  }
  assert.equal((await call(asDevice("GET", "/daily-plan", c.deviceKey), env)).res.status, 200, "other devices unaffected");
  assert.equal((await call(req("GET", "/daily-plan"), env)).res.status, 200, "legacy device unaffected");

  const again = await call(req("DELETE", "/devices/" + b.deviceId), env);
  assert.equal(again.res.status, 200);
  assert.equal(again.body.alreadyRevoked, true);

  const list = await call(req("GET", "/devices"), env);
  assert.equal(list.body.activeCount, 1);
  assert.equal(list.body.devices.find((d) => d.id === b.deviceId).active, false);

  const missing = await call(req("DELETE", "/devices/does-not-exist"), env);
  assert.equal(missing.res.status, 404);
});

test("a device can disconnect itself", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const self = await call(asDevice("DELETE", "/devices/" + b.deviceId, b.deviceKey), env);
  assert.equal(self.res.status, 200);
  assert.equal(self.body.current, true);
  assert.equal((await call(asDevice("GET", "/learner", b.deviceKey), env)).res.status, 401);
});

test("lastUsedAt is refreshed at most hourly, not on every request", async () => {
  const env = makeEnv();
  const b = await pairNewDevice(env);
  const first = env.DB.query("SELECT lastUsedAt FROM device_credential")[0].lastUsedAt;
  await atOffset(5 * 60 * 1000, () => call(asDevice("GET", "/learner", b.deviceKey), env));
  assert.equal(env.DB.query("SELECT lastUsedAt FROM device_credential")[0].lastUsedAt, first);
  await atOffset(61 * 60 * 1000, () => call(asDevice("GET", "/learner", b.deviceKey), env));
  assert.ok(env.DB.query("SELECT lastUsedAt FROM device_credential")[0].lastUsedAt > first);
});

test("wrong methods on pairing routes are 405", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("GET", "/pairing/start"), env)).status, 405);
  assert.equal((await worker.fetch(req("GET", "/pairing/claim", { key: null }), env)).status, 405);
  assert.equal((await worker.fetch(req("POST", "/devices"), env)).status, 405);
  assert.equal((await worker.fetch(req("POST", "/devices/abc"), env)).status, 405);
});

/* ---------------- security / regressions ---------------- */

test("the entire pairing lifecycle makes ZERO network calls and records no AI usage", async () => {
  const env = makeEnv();
  await withNoNetwork(async (stub) => {
    const b = await pairNewDevice(env, { label: "iPad" });
    await call(req("POST", "/pairing/start"), env);
    await call(req("POST", "/pairing/cancel"), env);
    await claim(env, "ZZZZ-ZZZZ");
    await call(asDevice("GET", "/devices", b.deviceKey), env);
    await call(req("DELETE", "/devices/" + b.deviceId), env);
    assert.equal(stub.calls.length, 0);
  });
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM ai_usage_daily")[0].n, 0);
});

test("no pairing or device response leaks the pepper, Gemini key, sync key, owner hash or credential hash", async () => {
  const env = makeEnv();
  const texts = [];
  const started = await call(req("POST", "/pairing/start"), env);
  texts.push(started.text);
  const claimed = await claim(env, started.body.code);
  const dk = claimed.body.deviceKey;
  texts.push((await claim(env, started.body.code)).text);
  texts.push((await call(asDevice("GET", "/devices", dk), env)).text);
  texts.push((await call(asDevice("POST", "/pairing/start", dk), env)).text);
  texts.push((await call(asDevice("POST", "/pairing/cancel", dk), env)).text);
  texts.push((await call(asDevice("GET", "/learner", generateDeviceKey()), env)).text);
  texts.push((await call(req("DELETE", "/devices/" + claimed.body.device.id), env)).text);
  texts.push((await call(asDevice("GET", "/learner", dk), env)).text);
  for (const t of texts) {
    assert.ok(!t.includes(TEST_PEPPER));
    assert.ok(!t.includes(TEST_GEMINI_KEY));
    assert.ok(!t.includes(TEST_SYNC_KEY));
    assert.ok(!t.includes(ownerHashOf(TEST_SYNC_KEY)));
    assert.ok(!t.includes(credentialHashOf(dk)));
    assert.ok(!t.includes(dk), "the device key must appear only in its own claim response");
  }
  // The claim response itself carries the key, and nothing else secret.
  assert.ok(!claimed.text.includes(TEST_PEPPER));
  assert.ok(!claimed.text.includes(ownerHashOf(TEST_SYNC_KEY)));
  assert.ok(!claimed.text.includes(credentialHashOf(dk)));
});

test("CORS: X-Device-Key is advertised, the allowlist is unchanged, claim is refused cross-origin", async () => {
  const env = makeEnv();
  const pre = await worker.fetch(req("OPTIONS", "/daily-plan", { key: null, origin: TEST_ORIGIN }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /X-Sync-Key/);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /X-Device-Key/);
  assert.match(pre.headers.get("Access-Control-Allow-Methods"), /DELETE/);

  const preClaim = await worker.fetch(req("OPTIONS", "/pairing/claim", { key: null, origin: TEST_ORIGIN }), env);
  assert.equal(preClaim.status, 204);
  const preEvil = await worker.fetch(req("OPTIONS", "/pairing/claim", { key: null, origin: "https://evil.example" }), env);
  assert.equal(preEvil.status, 403);

  const started = await startCode(env);
  const evil = await claim(env, started.code, {}, { origin: "https://evil.example" });
  assert.equal(evil.res.status, 403);
  assert.equal(evil.body.error, "origin_not_allowed");
  assert.equal(env.DB.query("SELECT COUNT(*) AS n FROM device_credential")[0].n, 0, "refused before anything was consumed");

  const ok = await claim(env, started.code, {}, { origin: TEST_ORIGIN });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);
  assert.equal(ok.res.headers.get("Cache-Control"), "no-store");

  const b = ok.body.deviceKey;
  const fromDevice = await worker.fetch(asDevice("GET", "/vocab/library", b, { origin: TEST_ORIGIN }), env);
  assert.equal(fromDevice.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);
});

test("the pairing tables exist and store no fingerprinting columns", () => {
  const env = makeEnv();
  const names = env.DB.query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of ["device_credential", "device_pairing_session", "pairing_claim_window"]) {
    assert.ok(names.includes(t), "missing table " + t);
  }
  for (const t of ["device_credential", "device_pairing_session", "pairing_claim_window"]) {
    const cols = env.DB.query("PRAGMA table_info(" + t + ")").map((c) => c.name.toLowerCase());
    for (const forbidden of ["user_agent", "useragent", "ip", "ip_address", "ipaddress", "code", "device_key", "devicekey", "sync_key"]) {
      assert.ok(!cols.includes(forbidden), t + " must not have a " + forbidden + " column");
    }
  }
});
