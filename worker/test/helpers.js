/**
 * Test doubles for the Worker: a real-SQLite stand-in for D1 and a controllable
 * stand-in for the Gemini HTTP endpoint. No network, no secrets, no Cloudflare.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A D1 double backed by real SQLite (node:sqlite), running the project's real
 * schema.sql plus every file in migrations/.
 *
 * The previous double hand-implemented the four statements worker.js issued.
 * That does not scale to the learning engine's joins, upserts and ordering, and
 * worse, it could not catch a mistake in the SQL itself. Running the actual
 * migrations against a real engine means the tests fail if a migration is
 * wrong, a column is missing, or a statement does not mean what it looks like.
 *
 * Still no network, no Cloudflare, no secrets: an in-memory database per test.
 */
export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readSchema());

  function normalizeArgs(args) {
    // node:sqlite refuses undefined and booleans; D1 accepts both.
    return args.map((a) => {
      if (a === undefined) return null;
      if (typeof a === "boolean") return a ? 1 : 0;
      return a;
    });
  }

  const api = {
    /** Vocabulary rows as a Map, so the pre-existing sync tests that inspect
        env.DB.rows keep working against the real table. */
    get rows() {
      const out = new Map();
      for (const r of db.prepare("SELECT * FROM vocabulary").all()) {
        out.set(r.owner_hash + " " + r.id, r);
      }
      return out;
    },
    /** Escape hatch for tests that need to seed state directly. */
    exec(sql) { db.exec(sql); },
    query(sql, ...args) { return db.prepare(sql).all(...normalizeArgs(args)); },
    prepare(sql) {
      return {
        bind(...args) {
          const bound = normalizeArgs(args);
          return {
            async all() {
              return { results: db.prepare(sql).all(...bound), success: true };
            },
            async first() {
              const row = db.prepare(sql).get(...bound);
              return row === undefined ? null : row;
            },
            async run() {
              const info = db.prepare(sql).run(...bound);
              return { meta: { changes: Number(info.changes) || 0 }, success: true };
            }
          };
        },
        async all() { return { results: db.prepare(sql).all(), success: true }; },
        async first() {
          const row = db.prepare(sql).get();
          return row === undefined ? null : row;
        },
        async run() {
          const info = db.prepare(sql).run();
          return { meta: { changes: Number(info.changes) || 0 }, success: true };
        }
      };
    }
  };
  return api;
}

let schemaCache = null;

/** schema.sql (migration 0001, already live) + every numbered migration,
    in filename order — exactly what the remote database has been given. */
function readSchema() {
  if (schemaCache !== null) return schemaCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const workerDir = join(here, "..");
  let sql = readFileSync(join(workerDir, "schema.sql"), "utf8");
  const migrationsDir = join(workerDir, "migrations");
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sql += "\n" + readFileSync(join(migrationsDir, name), "utf8");
  }
  schemaCache = sql;
  return sql;
}

/** Exposed so a test can assert the migrations are additive. */
export function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "..", "migrations");
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));
}

export const TEST_PEPPER = "test-pepper-value-not-the-real-one";
export const TEST_GEMINI_KEY = "AIzaTESTKEYtestkeyTESTKEYtestkey0000";
export const TEST_ORIGIN = "https://yoaveitan6-cmd.github.io";
export const TEST_SYNC_KEY = "k".repeat(32);

export function makeEnv(over = {}) {
  return {
    DB: makeDb(),
    SYNC_PEPPER: TEST_PEPPER,
    GEMINI_API_KEY: TEST_GEMINI_KEY,
    ALLOWED_ORIGINS: TEST_ORIGIN + ",http://localhost:8000",
    ...over
  };
}

const BASE = "https://english-sync.example.workers.dev";

export function req(method, path, { body, key = TEST_SYNC_KEY, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-Sync-Key"] = key;
  if (origin) h["Origin"] = origin;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
}

/* A well-formed model answer, in the exact shape generateContent returns. */
export function geminiOk(obj) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: JSON.stringify(obj) }] }
      }
    ]
  };
}

export const SAMPLE_FEEDBACK = {
  original: "Yesterday I go to the store.",
  corrected: "Yesterday I went to the store.",
  isCorrect: false,
  errorTypes: ["Past Simple", "Tense"],
  explanationHe: "המילה Yesterday מציינת זמן עבר, ולכן נדרש Past Simple.",
  naturalAlternatives: {
    everyday: "I went to the store yesterday.",
    neutral: "Yesterday I went to the store.",
    formal: "I visited the store yesterday."
  },
  followUpExercise: {
    instructionHe: "כתוב משפט אחד ב-Past Simple.",
    question: "What did you do yesterday evening?"
  }
};

/* Installs a fake global fetch. Returns a handle with the recorded calls. */
export function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

export function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/* ---------------- vocabulary MVP fixtures ---------------- */

/** One well-formed generated word, in the shape the generation schema asks for. */
export function generatedWord(n) {
  return {
    term: "phrase-" + n,
    hebrewMeaning: "פירוש-" + n,
    partOfSpeech: "phrasal verb",
    shortDefinitionEn: "To do the thing numbered " + n + " in a natural way.",
    exampleSentence: "I had to phrase-" + n + " the whole report before Friday.",
    register: "neutral",
    usefulnessNoteHe: "ביטוי שימושי בשיחה יומיומית.",
    topic: "work_career"
  };
}

export function generationBatch(count) {
  const items = [];
  for (let i = 1; i <= count; i++) items.push(generatedWord(i));
  return { items };
}

/** One well-formed meaning-in-context question per requested term. */
export function contextBatch(terms) {
  return {
    items: terms.map((t, i) => ({
      term: t,
      sentence: "In this sentence you can tell what " + t + " means from context " + i + ".",
      correctMeaning: "המשמעות הנכונה " + i,
      wrongMeanings: ["מסיח א" + i, "מסיח ב" + i, "מסיח ג" + i]
    }))
  };
}

export const SAMPLE_WRITE_EVAL = {
  usedCorrectly: true,
  isNatural: true,
  correctedSentence: "I finally figured out the problem.",
  explanationHe: "השימוש נכון וטבעי.",
  betterAlternative: ""
};

/**
 * Routes a stubbed Gemini call to a handler chosen by what the prompt asks for,
 * so one stub can serve a whole session flow. Returns the stub handle plus a
 * per-purpose call count, which is how the tests assert that batching actually
 * batched.
 */
export function stubGeminiByPurpose(handlers) {
  const counts = { generation: 0, context: 0, enrichment: 0, writeEval: 0, unknown: 0 };
  const stub = stubFetch(async (url, init) => {
    const payload = JSON.parse(init.body);
    const system = payload.systemInstruction.parts[0].text;
    const user = payload.contents[0].parts[0].text;

    let purpose = "unknown";
    if (/meaning-in-context questions/.test(system)) purpose = "context";
    else if (/judge ONE sentence/.test(system)) purpose = "writeEval";
    else if (/Term the learner wants to save/.test(user)) purpose = "enrichment";
    else if (/choose new English vocabulary/.test(system)) purpose = "generation";

    counts[purpose] = (counts[purpose] || 0) + 1;
    const handler = handlers[purpose];
    if (!handler) throw new Error("no stub handler for Gemini purpose: " + purpose);
    return handler(payload, user);
  });
  return { stub, counts, restore: () => stub.restore(), calls: stub.calls };
}
