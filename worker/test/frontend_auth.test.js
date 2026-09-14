/**
 * The browser half of device pairing.
 *
 * index.html stays a single file, so these tests read it, pull out the real
 * <script id="elp-auth"> block, and run exactly that code in a sandbox with a
 * fake localStorage, document and fetch. No copy of the logic lives here.
 *
 * What this file exists to prove:
 *   - a paired device sends X-Device-Key and needs no sync key at all
 *   - the device key always wins over a legacy key, saved or typed
 *   - exactly one auth header is ever sent
 *   - the connection survives a reload, and a browser that will not store it
 *     is never reported as connected
 *   - claiming a code sends no credential, and the raw key never leaves
 *     ElpAuth except into storage
 *   - no card builds its own credential header any more
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  normalizePairingCode as serverNormalize,
  generatePairingCode,
  generateDeviceKey,
  formatPairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH
} from "../src/auth.js";

const HTML = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const LS_DEVICE = "elp.device.credential";
const LS_SYNC_KEY = "elp.sync.key";
const LEGACY_KEY = "L".repeat(43);
const API = "https://english-sync.yoaveitan-english.workers.dev";

/** Objects made inside the sandbox have another realm's prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* Parsed once, so the same script is the same object everywhere. */
let scriptCache = null;
function scripts() {
  if (scriptCache) return scriptCache;
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(HTML))) out.push({ attrs: m[1], code: m[2], index: m.index });
  scriptCache = out;
  return out;
}

function authScript() {
  const s = scripts().find((x) => /id="elp-auth"/.test(x.attrs));
  assert.ok(s, 'index.html must contain <script id="elp-auth">');
  return s;
}

function makeStorage(initial = {}, { throwOnWrite = false, dropWrites = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnWrite) throw new Error("QuotaExceededError");
      if (!dropWrites) map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); }
  };
}

function storedDevice(key = generateDeviceKey()) {
  return { [LS_DEVICE]: JSON.stringify({ v: 1, key, deviceId: "dev-1", label: "iPhone", connectedAt: 1 }) };
}

/** One "page load": a fresh run of the real script over the given storage. */
function loadAuth({ storage = makeStorage(), fields = {}, fetchImpl } = {}) {
  const events = [];
  const document = {
    getElementById: (id) => (id in fields ? { value: fields[id] } : null),
    dispatchEvent: (e) => { events.push(e.type); return true; }
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const window = { localStorage: storage, document, CustomEvent, fetch: fetchImpl };
  vm.runInNewContext(authScript().code, { window });
  return { auth: window.ElpAuth, events, storage };
}

function headerNames(auth) {
  return Object.keys(auth.getAuthHeaders()).sort();
}

/* ---------------- header selection ---------------- */

test("a paired device sends only X-Device-Key and needs no sync key", () => {
  const key = generateDeviceKey();
  const { auth } = loadAuth({ storage: makeStorage(storedDevice(key)) });
  assert.deepEqual(plain(auth.getAuthHeaders()), { "X-Device-Key": key });
  assert.equal(auth.hasAuth(), true);
  assert.equal(auth.authMethod(), "device_key");
  assert.equal(auth.authProblem(), null);
  assert.equal(auth.getApiBase(), API);
});

test("the device key is preferred over a saved legacy key AND over one typed into the Advanced field", () => {
  const key = generateDeviceKey();
  const { auth } = loadAuth({
    storage: makeStorage({ ...storedDevice(key), [LS_SYNC_KEY]: LEGACY_KEY }),
    fields: { syncKey: "a-freshly-generated-but-wrong-legacy-key-xyz" }
  });
  assert.deepEqual(plain(auth.getAuthHeaders()), { "X-Device-Key": key });
});

test("a legacy-only device keeps sending X-Sync-Key, typed value first, as before", () => {
  const saved = loadAuth({ storage: makeStorage({ [LS_SYNC_KEY]: LEGACY_KEY }) }).auth;
  assert.deepEqual(plain(saved.getAuthHeaders()), { "X-Sync-Key": LEGACY_KEY });
  assert.equal(saved.authMethod(), "sync_key");

  const typed = loadAuth({ storage: makeStorage({ [LS_SYNC_KEY]: LEGACY_KEY }), fields: { syncKey: "T".repeat(30) } }).auth;
  assert.deepEqual(plain(typed.getAuthHeaders()), { "X-Sync-Key": "T".repeat(30) });

  const short = loadAuth({ storage: makeStorage({ [LS_SYNC_KEY]: "short" }) }).auth;
  assert.deepEqual(plain(short.getAuthHeaders()), {});
  assert.match(short.authProblem(), /only 5 characters/);
});

test("exactly one auth header in every combination of stored and typed credentials", () => {
  const deviceStates = [{}, storedDevice(), { [LS_DEVICE]: '{"key":"dk_malformed"}' }, { [LS_DEVICE]: "not json" }];
  const legacyStates = [{}, { [LS_SYNC_KEY]: LEGACY_KEY }, { [LS_SYNC_KEY]: "short" }];
  const fieldStates = [{}, { syncKey: "F".repeat(25) }, { syncKey: "tiny" }];
  let combos = 0;
  for (const d of deviceStates) {
    for (const l of legacyStates) {
      for (const f of fieldStates) {
        const { auth } = loadAuth({ storage: makeStorage({ ...d, ...l }), fields: f });
        const names = headerNames(auth);
        assert.ok(names.length <= 1, "more than one auth header: " + names.join(", "));
        assert.equal(names.length === 1, auth.hasAuth(), "hasAuth must agree with whether a header is sent");
        combos++;
      }
    }
  }
  assert.equal(combos, 36);
});

test("an unconnected device is told to connect — not to find a Worker URL or a sync key", () => {
  const { auth } = loadAuth();
  assert.equal(auth.hasAuth(), false);
  assert.equal(auth.authMethod(), null);
  assert.deepEqual(plain(auth.getAuthHeaders()), {});
  assert.match(auth.authProblem(), /Connect this device/);
  assert.doesNotMatch(auth.authProblem(), /Worker URL|sync key/i);
});

test("a corrupt stored credential is ignored rather than sent", () => {
  const { auth } = loadAuth({ storage: makeStorage({ [LS_DEVICE]: '{"key":"dk_short"}', [LS_SYNC_KEY]: LEGACY_KEY }) });
  assert.deepEqual(plain(auth.getAuthHeaders()), { "X-Sync-Key": LEGACY_KEY });
});

/* ---------------- storing and clearing ---------------- */

test("the connection survives a reload: a new page load over the same storage is still paired", () => {
  const storage = makeStorage();
  const key = generateDeviceKey();
  const first = loadAuth({ storage });
  assert.equal(first.auth.saveDeviceCredential({ deviceKey: key, deviceId: "dev-9", label: "iPhone" }), true);
  assert.deepEqual(first.events, ["english:auth-changed"]);

  const reloaded = loadAuth({ storage }).auth;
  assert.equal(reloaded.authMethod(), "device_key");
  assert.deepEqual(plain(reloaded.getAuthHeaders()), { "X-Device-Key": key });
  assert.deepEqual(plain(reloaded.getDeviceInfo()).deviceId, "dev-9");
  assert.ok(!JSON.stringify(plain(reloaded.getDeviceInfo())).includes(key), "device info must not expose the key");
});

test("a browser that refuses or silently drops storage is never reported as connected", () => {
  const key = generateDeviceKey();
  const throwing = loadAuth({ storage: makeStorage({}, { throwOnWrite: true }) }).auth;
  assert.equal(throwing.saveDeviceCredential({ deviceKey: key }), false);
  assert.equal(throwing.hasAuth(), false);

  const dropping = loadAuth({ storage: makeStorage({}, { dropWrites: true }) }).auth;
  assert.equal(dropping.saveDeviceCredential({ deviceKey: key }), false);
  assert.equal(dropping.hasAuth(), false);

  const bad = loadAuth().auth;
  for (const k of ["", "dk_", "dk_short", LEGACY_KEY, null, 42, key + "x"]) {
    assert.equal(bad.saveDeviceCredential({ deviceKey: k }), false, "accepted " + k);
  }
  // Every key the server can issue is one the browser accepts.
  for (let i = 0; i < 200; i++) {
    assert.equal(loadAuth().auth.saveDeviceCredential({ deviceKey: generateDeviceKey() }), true);
  }
});

test("disconnecting clears only the device key and falls back to a legacy key if one exists", () => {
  const storage = makeStorage({ ...storedDevice(), [LS_SYNC_KEY]: LEGACY_KEY });
  const { auth, events } = loadAuth({ storage });
  auth.clearDeviceCredential();
  assert.equal(storage.map.has(LS_DEVICE), false);
  assert.equal(storage.map.get(LS_SYNC_KEY), LEGACY_KEY, "the legacy key is not touched");
  assert.deepEqual(plain(auth.getAuthHeaders()), { "X-Sync-Key": LEGACY_KEY });
  assert.deepEqual(events, ["english:auth-changed"]);
});

test("a 401 is reported so the Devices card can re-check; other statuses are not", () => {
  const { auth, events } = loadAuth({ storage: makeStorage(storedDevice()) });
  auth.reportStatus(200);
  auth.reportStatus(409);
  auth.reportStatus(401);
  assert.deepEqual(events, ["english:auth-rejected"]);
});

/* ---------------- claiming ---------------- */

test("claiming sends the code with NO credential header, stores the key, and never hands the raw key back", async () => {
  const issued = generateDeviceKey();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ connected: true, deviceKey: issued, device: { id: "dev-2", label: "iPhone", createdAt: 1 } }), { status: 200 });
  };
  // Even with a legacy key saved and typed, the claim must not carry it.
  const storage = makeStorage({ [LS_SYNC_KEY]: LEGACY_KEY });
  const { auth } = loadAuth({ storage, fields: { syncKey: LEGACY_KEY }, fetchImpl });

  const result = plain(await auth.claimPairingCode(" ab7k 3m9q ", "  iPhone "));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API + "/pairing/claim");
  assert.ok(!calls[0].url.includes("?"), "nothing in the query string");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(Object.keys(calls[0].init.headers), ["Content-Type"]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: "AB7K3M9Q", label: "iPhone" });
  assert.equal(calls[0].init.credentials, "omit");

  assert.equal(result.ok, true);
  assert.equal(result.stored, true);
  assert.ok(!JSON.stringify(result).includes(issued), "the raw key must not be returned to the UI");
  assert.equal(JSON.parse(storage.map.get(LS_DEVICE)).key, issued);
  assert.deepEqual(plain(auth.getAuthHeaders()), { "X-Device-Key": issued }, "the device key now wins over the legacy key");
  assert.equal(storage.map.get(LS_SYNC_KEY), LEGACY_KEY, "the legacy key is left alone");
});

test("a malformed code is refused without a network call; a rejected code stores nothing", async () => {
  let calls = 0;
  const reject = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "invalid_pairing_code", message: "That code did not work." }), { status: 400 });
  };
  const storage = makeStorage();
  const { auth } = loadAuth({ storage, fetchImpl: reject });

  for (const bad of ["", "ABC", "AB0K-3M9Q", "AB7K-3M9Q-XX", null]) {
    const r = plain(await auth.claimPairingCode(bad, ""));
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0);

  const r = plain(await auth.claimPairingCode("AB7K-3M9Q", ""));
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(storage.map.has(LS_DEVICE), false);
  assert.equal(auth.hasAuth(), false);
});

test("browser and Worker agree exactly on what a pairing code is", () => {
  const { auth } = loadAuth();
  const src = authScript().code;
  assert.ok(src.includes('"' + PAIRING_CODE_ALPHABET + '"'), "the browser alphabet must match the Worker's");
  assert.ok(src.includes("CODE_LENGTH = " + PAIRING_CODE_LENGTH));

  const inputs = [
    "", " ", "AB7K-3M9Q", "ab7k-3m9q", "AB7K 3M9Q", "AB7K3M9Q", "AB7K--3M9Q", " AB7K-3M9Q ",
    "AB0K-3M9Q", "AB1K-3M9Q", "ABOK-3M9Q", "ABIK-3M9Q", "ABLK-3M9Q", "AB7K-3M9", "AB7K-3M9QQ",
    "AB7K_3M9Q", "AB7K.3M9Q", "x".repeat(40), "ÄB7K-3M9Q", null, undefined, 12345678, {}
  ];
  for (let i = 0; i < 300; i++) {
    const c = generatePairingCode();
    inputs.push(c, formatPairingCode(c), formatPairingCode(c).toLowerCase(), c.slice(0, 7));
  }
  for (const input of inputs) {
    assert.equal(auth.normalizePairingCode(input), serverNormalize(input), "disagree on " + JSON.stringify(input));
  }
});

/* ---------------- the page as a whole ---------------- */

test("ElpAuth loads before every script that calls the Worker", () => {
  const auth = authScript();
  const callers = scripts().filter((s) => /\bfetch\(/.test(s.code) && s !== auth);
  assert.ok(callers.length >= 6, "expected the sync, AI, plan, vocabulary, sentence and devices scripts");
  for (const s of callers) assert.ok(s.index > auth.index, "a Worker caller runs before ElpAuth exists");
});

test("no card builds its own credential header or reads the legacy key itself", () => {
  const auth = authScript();
  for (const s of scripts()) {
    if (s === auth) continue;
    assert.ok(!/["']X-Sync-Key["']\s*:/.test(s.code), "a card still builds an X-Sync-Key header itself");
    assert.ok(!/["']X-Device-Key["']\s*:/.test(s.code), "a card builds an X-Device-Key header itself");
    assert.ok(!s.code.includes("elp.device.credential"), "only ElpAuth may touch the device credential");
    if (/\bfetch\(/.test(s.code)) {
      const usesAuth = s.code.includes("ElpAuth.getAuthHeaders()") || s.code.includes("ElpAuth.claimPairingCode(");
      assert.ok(usesAuth, "a script calls fetch without going through ElpAuth");
    }
  }
  // The legacy key's storage name survives only where the Advanced controls save/forget it.
  const legacyReaders = scripts().filter((s) => s !== auth && s.code.includes("elp.sync.key"));
  assert.equal(legacyReaders.length, 1);
  assert.ok(legacyReaders[0].code.includes("btnForgetKey"), "only the legacy sync card may save/forget the sync key");
});

test("the claim request is made only through ElpAuth, and the device key is never put in a URL", () => {
  const auth = authScript();
  for (const s of scripts()) {
    if (s === auth) continue;
    assert.ok(!s.code.includes("/pairing/claim"), "the claim must go through ElpAuth.claimPairingCode");
  }
  assert.ok(!/[?&](deviceKey|device_key|syncKey|sync_key|code)=/.test(HTML), "no credential or code in a query string");
});

test("the raw sync-key controls are behind an Advanced / legacy disclosure, and onboarding is Connect this device", () => {
  const details = /<details[^>]*id="legacySyncDetails"[^>]*>([\s\S]*?)<\/details>/.exec(HTML);
  assert.ok(details, "legacy controls must be inside <details id=\"legacySyncDetails\">");
  assert.match(details[1], /<summary>[^<]*Advanced[^<]*legacy[^<]*<\/summary>/i);
  for (const id of ["syncApi", "syncKey", "btnGenKey", "btnSaveKey", "btnForgetKey"]) {
    assert.ok(details[1].includes('id="' + id + '"'), id + " must be inside the Advanced section");
  }
  assert.ok(!/<details[^>]*id="legacySyncDetails"[^>]*\sopen/.test(HTML), "Advanced must start collapsed");

  assert.ok(HTML.includes('id="deviceCard"'));
  assert.ok(HTML.indexOf('id="deviceCard"') < HTML.indexOf('id="todayCard"'), "Devices comes before Today's Plan");
  assert.match(HTML, /id="devicePairCode"/);
  assert.match(HTML, /id="btnDeviceConnect"/);
  assert.match(HTML, /id="btnPairStart"[^>]*>\s*Pair another device/);
  assert.ok(!/Save your Worker URL and sync key/.test(HTML), "no card should still tell the learner to find a sync key");
});
