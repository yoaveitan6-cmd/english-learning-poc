/**
 * Tests for POST /ai/correct. Gemini is always a stub here — no real network
 * call is made and no real API key exists in this process.
 */
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  makeEnv,
  req,
  stubFetch,
  jsonResponse,
  geminiOk,
  SAMPLE_FEEDBACK,
  TEST_GEMINI_KEY,
  TEST_ORIGIN,
  TEST_SYNC_KEY
} from "./helpers.js";

async function call(request, env) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, text, body };
}

function correctReq(sentence, opts = {}) {
  return req("POST", "/ai/correct", { body: { sentence }, ...opts });
}

/* Convenience: run one request against a stubbed Gemini and always restore. */
async function withGemini(handler, run) {
  const stub = stubFetch(handler);
  try {
    return await run(stub);
  } finally {
    stub.restore();
  }
}

/* ---------------- happy path ---------------- */

test("a valid structured Gemini answer is returned to the browser", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 1);

      const fb = body.feedback;
      assert.equal(fb.original, "Yesterday I go to the store.");
      assert.equal(fb.corrected, "Yesterday I went to the store.");
      assert.equal(fb.isCorrect, false);
      assert.deepEqual(fb.errorTypes, ["Past Simple", "Tense"]);
      assert.ok(fb.explanationHe.length > 0);
      assert.equal(fb.naturalAlternatives.everyday, "I went to the store yesterday.");
      assert.equal(fb.naturalAlternatives.formal, "I visited the store yesterday.");
      assert.ok(fb.followUpExercise.question.length > 0);
      assert.ok(fb.followUpExercise.instructionHe.length > 0);
      assert.equal(body.model, "gemini-3.8-flash");
    }
  );
});

test("a sentence the model calls correct comes back with no invented errors", async () => {
  const answer = {
    ...SAMPLE_FEEDBACK,
    original: "What is your opinion on this?",
    corrected: "What is your opinion on this?",
    isCorrect: true,
    errorTypes: [],
    naturalAlternatives: {
      everyday: "What do you think about this?",
      neutral: "What is your opinion on this?",
      formal: "What is your opinion on this matter?"
    }
  };
  await withGemini(
    () => jsonResponse(200, geminiOk(answer)),
    async () => {
      const { res, body } = await call(correctReq("What is your opinion on this?"), makeEnv());
      assert.equal(res.status, 200);
      assert.equal(body.feedback.isCorrect, true);
      assert.deepEqual(body.feedback.errorTypes, []);
      assert.equal(body.feedback.corrected, "What is your opinion on this?");
    }
  );
});

test("the echoed original is the learner's own sentence, not the model's", async () => {
  const answer = { ...SAMPLE_FEEDBACK, original: "something the model made up" };
  await withGemini(
    () => jsonResponse(200, geminiOk(answer)),
    async () => {
      const { body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(body.feedback.original, "Yesterday I go to the store.");
    }
  );
});

/* ---------------- the outgoing request ---------------- */

test("the model is called with a response schema, low temperature and no tools", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      await call(correctReq("Yesterday I go to the store."), makeEnv());
      const c = stub.calls[0];

      assert.match(c.url, /generativelanguage\.googleapis\.com/);
      assert.match(c.url, /models\/gemini-3\.8-flash:generateContent$/);

      const payload = JSON.parse(c.init.body);
      assert.equal(payload.generationConfig.responseMimeType, "application/json");
      assert.equal(payload.generationConfig.responseSchema.type, "OBJECT");
      assert.ok(payload.generationConfig.temperature <= 0.5);
      assert.ok(payload.generationConfig.maxOutputTokens > 0);

      // Free tier only: nothing that would turn on a billed feature.
      assert.equal(payload.tools, undefined);
      assert.equal(payload.toolConfig, undefined);
      const raw = c.init.body;
      for (const forbidden of ["googleSearch", "google_search", "googleMaps", "retrieval", "urlContext", "codeExecution"]) {
        assert.ok(!raw.includes(forbidden), "payload must not contain " + forbidden);
      }

      // The learner's sentence travels as user content, never as an instruction.
      assert.match(payload.contents[0].parts[0].text, /Yesterday I go to the store\./);
      assert.equal(payload.contents[0].role, "user");
      assert.ok(!payload.systemInstruction.parts[0].text.includes("Yesterday I go to the store."));
    }
  );
});

test("the API key goes in a header, never in the URL", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      await call(correctReq("Yesterday I go to the store."), makeEnv());
      const c = stub.calls[0];
      assert.equal(c.init.headers["x-goog-api-key"], TEST_GEMINI_KEY);
      assert.ok(!c.url.includes(TEST_GEMINI_KEY));
      assert.ok(!c.url.includes("key="));
    }
  );
});

test("the sync key is never forwarded to Google", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      await call(correctReq("Yesterday I go to the store."), makeEnv());
      const c = stub.calls[0];
      assert.ok(!JSON.stringify(c.init.headers).includes(TEST_SYNC_KEY));
      assert.ok(!c.init.body.includes(TEST_SYNC_KEY));
    }
  );
});

/* ---------------- auth ---------------- */

test("no X-Sync-Key means 401 and Gemini is never called", async () => {
  await withGemini(
    () => { throw new Error("Gemini must not be called"); },
    async (stub) => {
      const { res, body } = await call(correctReq("Yesterday I go to the store.", { key: null }), makeEnv());
      assert.equal(res.status, 401);
      assert.equal(body.error, "missing_sync_key");
      assert.equal(stub.calls.length, 0);
    }
  );
});

test("a too-short sync key means 401 and Gemini is never called", async () => {
  await withGemini(
    () => { throw new Error("Gemini must not be called"); },
    async (stub) => {
      const { res, body } = await call(correctReq("Hello there.", { key: "abc" }), makeEnv());
      assert.equal(res.status, 401);
      assert.equal(body.error, "sync_key_too_short");
      assert.equal(stub.calls.length, 0);
    }
  );
});

test("a missing GEMINI_API_KEY is reported as a server configuration problem", async () => {
  await withGemini(
    () => { throw new Error("Gemini must not be called"); },
    async (stub) => {
      const env = makeEnv({ GEMINI_API_KEY: undefined });
      const { res, body } = await call(correctReq("Hello there."), env);
      assert.equal(res.status, 500);
      assert.equal(body.error, "server_not_configured");
      assert.equal(stub.calls.length, 0);
    }
  );
});

/* ---------------- input validation ---------------- */

test("bad input is rejected with 4xx before any model call", async () => {
  const cases = [
    { name: "missing sentence", body: {}, error: "validation_failed" },
    { name: "null sentence", body: { sentence: null }, error: "validation_failed" },
    { name: "number sentence", body: { sentence: 42 }, error: "validation_failed" },
    { name: "object sentence", body: { sentence: { a: 1 } }, error: "validation_failed" },
    { name: "empty sentence", body: { sentence: "" }, error: "validation_failed" },
    { name: "whitespace sentence", body: { sentence: "   \n\t " }, error: "validation_failed" },
    { name: "too long", body: { sentence: "word ".repeat(200) }, error: "validation_failed" }
  ];

  await withGemini(
    () => { throw new Error("Gemini must not be called"); },
    async (stub) => {
      for (const c of cases) {
        const { res, body } = await call(req("POST", "/ai/correct", { body: c.body }), makeEnv());
        assert.equal(res.status, 400, c.name + " should be 400");
        assert.equal(body.error, c.error, c.name);
        assert.equal(body.field, "sentence", c.name);
      }
      assert.equal(stub.calls.length, 0);
    }
  );
});

test("a non-JSON body is a 400, not a crash", async () => {
  const { res, body } = await call(
    req("POST", "/ai/correct", { body: "this is not json" }),
    makeEnv()
  );
  assert.equal(res.status, 400);
  assert.equal(body.error, "bad_json");
});

test("GET /ai/correct is 405 with an Allow header", async () => {
  const res = await worker.fetch(req("GET", "/ai/correct"), makeEnv());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});

/* ---------------- malformed model output ---------------- */

test("model output that is not JSON becomes a clean 502", async () => {
  await withGemini(
    () => jsonResponse(200, {
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Sure! Here is my answer." }] } }]
    }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_bad_output");
      assert.ok(!body.message.includes("Sure! Here is my answer."));
    }
  );
});

test("model output missing required fields becomes a clean 502", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk({ corrected: "Yesterday I went to the store." })),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_bad_output");
    }
  );
});

test("a non-boolean isCorrect is refused rather than coerced", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk({ ...SAMPLE_FEEDBACK, isCorrect: "false" })),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_bad_output");
    }
  );
});

test("a JSON answer wrapped in a code fence is still accepted", async () => {
  await withGemini(
    () => jsonResponse(200, {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: "```json\n" + JSON.stringify(SAMPLE_FEEDBACK) + "\n```" }] }
        }
      ]
    }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 200);
      assert.equal(body.feedback.corrected, "Yesterday I went to the store.");
    }
  );
});

test("reasoning parts are skipped when reading the answer", async () => {
  await withGemini(
    () => jsonResponse(200, {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Let me think about the tense here...", thought: true },
              { text: JSON.stringify(SAMPLE_FEEDBACK) }
            ]
          }
        }
      ]
    }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 200);
      assert.equal(body.feedback.isCorrect, false);
    }
  );
});

test("a truncated answer is reported as truncated, not as garbage", async () => {
  await withGemini(
    () => jsonResponse(200, {
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{\"corrected\":" }] } }]
    }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_output_truncated");
    }
  );
});

test("a blocked prompt is reported as blocked", async () => {
  await withGemini(
    () => jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_blocked");
    }
  );
});

test("oversized model fields are capped", async () => {
  const huge = {
    ...SAMPLE_FEEDBACK,
    corrected: "x".repeat(5000),
    errorTypes: new Array(50).fill("Tense")
  };
  await withGemini(
    () => jsonResponse(200, geminiOk(huge)),
    async () => {
      const { body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.ok(body.feedback.corrected.length <= 1000);
      assert.ok(body.feedback.errorTypes.length <= 8);
    }
  );
});

/* ---------------- upstream failures ---------------- */

test("a Gemini 429 becomes a 429 with a quota message", async () => {
  await withGemini(
    () => jsonResponse(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric." }
    }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 429);
      assert.equal(body.error, "ai_rate_limited");
      assert.equal(body.upstreamStatus, 429);
      assert.match(body.message, /quota/i);
    }
  );
});

test("a Gemini 500 becomes a 502 without echoing the upstream payload", async () => {
  await withGemini(
    () => jsonResponse(500, {
      error: {
        code: 500,
        status: "INTERNAL",
        message: "Internal error",
        details: [{ stack: "internal google trace that must not be forwarded" }]
      }
    }),
    async () => {
      const { res, body, text } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_upstream_error");
      assert.ok(!text.includes("internal google trace"));
    }
  );
});

test("a Gemini 404 says the model is unavailable", async () => {
  await withGemini(
    () => jsonResponse(404, { error: { code: 404, status: "NOT_FOUND", message: "models/x is not found" } }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_model_unavailable");
      assert.equal(body.upstreamStatus, 404);
    }
  );
});

test("a Gemini 403 asks for a human check", async () => {
  await withGemini(
    () => jsonResponse(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "billing required" } }),
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_not_authorized");
    }
  );
});

test("a network failure reaching Gemini becomes a 504", async () => {
  await withGemini(
    () => { throw new TypeError("fetch failed"); },
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 504);
      assert.equal(body.error, "ai_unreachable");
    }
  );
});

test("an aborted (timed out) request becomes a 504", async () => {
  await withGemini(
    () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
    async () => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 504);
      assert.equal(body.error, "ai_timeout");
    }
  );
});

test("a non-JSON upstream body is handled, not forwarded", async () => {
  await withGemini(
    () => new Response("<html>503 Service Unavailable</html>", { status: 503 }),
    async () => {
      const { res, body, text } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_upstream_error");
      assert.ok(!text.includes("<html>"));
    }
  );
});

/* ---------------- secret exposure ---------------- */

test("no error path leaks the Gemini key or the pepper", async () => {
  const leaky = (status) => jsonResponse(status, {
    error: {
      code: status,
      status: "INVALID_ARGUMENT",
      message: "API key not valid: " + TEST_GEMINI_KEY
    }
  });

  for (const status of [400, 403, 429, 500]) {
    await withGemini(
      () => leaky(status),
      async () => {
        const env = makeEnv();
        const { text } = await call(correctReq("Yesterday I go to the store."), env);
        assert.ok(!text.includes(TEST_GEMINI_KEY), "status " + status + " leaked the API key");
        assert.ok(!text.includes(env.SYNC_PEPPER), "status " + status + " leaked the pepper");
        assert.ok(text.includes("[redacted]"), "status " + status + " should show a redaction marker");
      }
    );
  }
});

test("a successful response contains no secret material", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async () => {
      const env = makeEnv();
      const { text } = await call(correctReq("Yesterday I go to the store."), env);
      assert.ok(!text.includes(TEST_GEMINI_KEY));
      assert.ok(!text.includes(env.SYNC_PEPPER));
      assert.ok(!text.includes(TEST_SYNC_KEY));
    }
  );
});

/* ---------------- CORS ---------------- */

test("/ai/correct honours the same origin allowlist as the sync endpoints", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      const env = makeEnv();

      const ok = await worker.fetch(correctReq("Yesterday I go to the store.", { origin: TEST_ORIGIN }), env);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);

      const bad = await call(correctReq("Yesterday I go to the store.", { origin: "https://evil.example" }), env);
      assert.equal(bad.res.status, 403);
      assert.equal(bad.body.error, "origin_not_allowed");
      assert.equal(stub.calls.length, 1, "the refused origin must not reach Gemini");
    }
  );
});

/* ---------------- persistence: counters only ---------------- */

test("an AI request stores no vocabulary, sentence or feedback", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async () => {
      const env = makeEnv();
      await call(correctReq("Yesterday I go to the store."), env);
      assert.equal(env.DB.rows.size, 0, "no vocabulary row was created");
      // The only write is an anonymous counter. Prove the sentence and the
      // model's answer are nowhere in the database.
      const dump = JSON.stringify(env.DB.query("SELECT * FROM ai_usage_daily"));
      assert.ok(!dump.includes("Yesterday I go"));
      assert.ok(!dump.includes(SAMPLE_FEEDBACK.corrected));
      assert.ok(!dump.includes(TEST_SYNC_KEY));
      assert.ok(!dump.includes(TEST_GEMINI_KEY));
    }
  );
});

/* ---------------- AI usage accounting ---------------- */

test("a successful AI call is counted by day and purpose", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async () => {
      const env = makeEnv();
      await call(correctReq("Yesterday I go to the store."), env);
      await call(correctReq("She have three cats."), env);

      const usage = await call(req("GET", "/ai/usage"), env);
      assert.equal(usage.res.status, 200);
      assert.equal(usage.body.totalCalls, 2);
      assert.equal(usage.body.usage[0].purpose, "correct");
      assert.equal(usage.body.usage[0].failures, 0);
      assert.match(usage.body.note, /does not model or enforce/i);
    }
  );
});

test("a failed AI call is counted as a failure, and the error is unchanged", async () => {
  await withGemini(
    () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }),
    async () => {
      const env = makeEnv();
      const r = await call(correctReq("Yesterday I go to the store."), env);
      assert.equal(r.res.status, 429, "accounting must not change the response");
      assert.equal(r.body.error, "ai_rate_limited");

      const usage = await call(req("GET", "/ai/usage"), env);
      assert.equal(usage.body.totalCalls, 1);
      assert.equal(usage.body.usage[0].failures, 1);
    }
  );
});

test("usage is per sync identity", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async () => {
      const env = makeEnv();
      await call(correctReq("Yesterday I go to the store."), env);
      const other = await call(req("GET", "/ai/usage", { key: "q".repeat(40) }), env);
      assert.equal(other.body.totalCalls, 0);
    }
  );
});

test("a broken usage counter never breaks the AI answer", async () => {
  await withGemini(
    () => jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async () => {
      const env = makeEnv();
      // Simulate a database that cannot record accounting at all.
      const realPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        if (sql.includes("ai_usage_daily")) throw new Error("no such table");
        return realPrepare(sql);
      };
      const r = await call(correctReq("Yesterday I go to the store."), env);
      assert.equal(r.res.status, 200);
      assert.equal(r.body.feedback.corrected, SAMPLE_FEEDBACK.corrected);
    }
  );
});

/* ---------------- transient-overload retry ---------------- */

test("a 503 is retried and a later success is returned", async () => {
  await withGemini(
    (url, init, n) =>
      n === 1
        ? jsonResponse(503, { error: { code: 503, status: "UNAVAILABLE", message: "high demand" } })
        : jsonResponse(200, geminiOk(SAMPLE_FEEDBACK)),
    async (stub) => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 2);
      assert.equal(body.feedback.corrected, "Yesterday I went to the store.");
    }
  );
});

test("a persistent 503 gives up after a bounded number of attempts", async () => {
  await withGemini(
    () => jsonResponse(503, { error: { code: 503, status: "UNAVAILABLE", message: "high demand" } }),
    async (stub) => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_upstream_error");
      assert.equal(stub.calls.length, 3);
    }
  );
});

test("a 429 is never retried, so the quota is not hammered", async () => {
  await withGemini(
    () => jsonResponse(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }),
    async (stub) => {
      const { res } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 429);
      assert.equal(stub.calls.length, 1);
    }
  );
});

test("a 400 is never retried", async () => {
  await withGemini(
    () => jsonResponse(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad schema" } }),
    async (stub) => {
      const { res, body } = await call(correctReq("Yesterday I go to the store."), makeEnv());
      assert.equal(res.status, 502);
      assert.equal(body.error, "ai_request_rejected");
      assert.equal(stub.calls.length, 1);
    }
  );
});
