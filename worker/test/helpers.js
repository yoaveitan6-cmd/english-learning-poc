/**
 * Test doubles for the Worker: an in-memory stand-in for D1 and a controllable
 * stand-in for the Gemini HTTP endpoint. No network, no secrets, no Cloudflare.
 */

/* A D1 stub that understands exactly the four statements worker.js issues.
   It is deliberately literal: if the SQL changes, these tests should fail. */
export function makeDb() {
  const rows = new Map(); // `${owner_hash} ${id}` -> row

  function key(owner, id) { return owner + " " + id; }

  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (!sql.startsWith("SELECT id, english") || !sql.includes("ORDER BY")) {
                throw new Error("unexpected all() SQL: " + sql);
              }
              const owner = args[0];
              const out = [...rows.values()]
                .filter((r) => r.owner_hash === owner)
                .map((r) => ({
                  id: r.id,
                  english: r.english,
                  hebrew: r.hebrew,
                  createdAt: r.createdAt,
                  updatedAt: r.updatedAt
                }))
                .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : 1));
              return { results: out };
            },
            async first() {
              if (!sql.includes("WHERE owner_hash = ? AND id = ?")) {
                throw new Error("unexpected first() SQL: " + sql);
              }
              const r = rows.get(key(args[0], args[1]));
              if (!r) return null;
              return {
                id: r.id,
                english: r.english,
                hebrew: r.hebrew,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt
              };
            },
            async run() {
              if (sql.startsWith("INSERT INTO vocabulary")) {
                const [owner_hash, id, english, hebrew, createdAt, updatedAt] = args;
                const k = key(owner_hash, id);
                const existing = rows.get(k);
                if (!existing) {
                  rows.set(k, { owner_hash, id, english, hebrew, createdAt, updatedAt });
                  return { meta: { changes: 1 } };
                }
                // ON CONFLICT ... WHERE excluded.updatedAt >= vocabulary.updatedAt
                if (updatedAt >= existing.updatedAt) {
                  existing.english = english;
                  existing.hebrew = hebrew;
                  existing.updatedAt = updatedAt;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.startsWith("DELETE FROM vocabulary")) {
                const k = key(args[0], args[1]);
                const had = rows.delete(k);
                return { meta: { changes: had ? 1 : 0 } };
              }
              throw new Error("unexpected run() SQL: " + sql);
            }
          };
        }
      };
    }
  };
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
