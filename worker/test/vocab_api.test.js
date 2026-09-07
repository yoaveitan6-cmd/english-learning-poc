/**
 * End-to-end tests for the Vocabulary MVP, over the real Worker with a real
 * SQLite database running the real migrations. Gemini is always a stub; no
 * network call leaves this process and no real key exists in it.
 *
 * What this file exists to prove:
 *   - the three vocabulary sources behave differently, and a detected word
 *     cannot reach daily learning without the learner approving it
 *   - the day's new words are generated ONCE, and a reload or a second device
 *     re-reads them rather than spending quota again
 *   - deterministic exercise types make zero AI calls
 *   - a session cannot be completed without actually being done
 *   - completing one closes the Today's Plan activity, durably
 *   - none of it is visible to another sync key
 */
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  makeEnv,
  req,
  stubFetch,
  stubGeminiByPurpose,
  jsonResponse,
  geminiOk,
  generationBatch,
  generatedWord,
  contextBatch,
  SAMPLE_WRITE_EVAL,
  TEST_GEMINI_KEY,
  TEST_ORIGIN,
  TEST_SYNC_KEY
} from "./helpers.js";
import { msToDateKey } from "../src/planner.js";

const OTHER_KEY = "z".repeat(40);

async function call(request, env) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, text, body };
}

function todayKey() {
  return msToDateKey(Date.now(), 0);
}

/** Runs a block with every Gemini purpose answered by a well-formed stub. */
async function withGemini(run, over = {}) {
  const g = stubGeminiByPurpose({
    generation: () => jsonResponse(200, geminiOk(generationBatch(8))),
    context: (payload, user) => {
      const terms = [...user.matchAll(/term: (.+)/g)].map((m) => m[1].trim());
      return jsonResponse(200, geminiOk(contextBatch(terms)));
    },
    enrichment: (payload, user) => {
      const term = user.split("\n").pop().trim();
      return jsonResponse(200, geminiOk({ ...generatedWord(1), term }));
    },
    writeEval: () => jsonResponse(200, geminiOk(SAMPLE_WRITE_EVAL)),
    ...over
  });
  try {
    return await run(g);
  } finally {
    g.restore();
  }
}

/** Runs a block with fetch fatal, so any AI call fails loudly. */
async function withNoNetwork(run) {
  const stub = stubFetch(() => { throw new Error("unexpected AI call"); });
  try {
    return await run(stub);
  } finally {
    stub.restore();
  }
}

/** Today's plan, which the daily vocabulary session is required to consume. */
async function makePlan(env, mode = "standard", key = TEST_SYNC_KEY) {
  const r = await call(req("POST", "/daily-plan", { body: { mode }, key }), env);
  assert.equal(r.res.status, 200, r.text);
  return r.body.plan;
}

/** Answers every question in a session with whatever the server considers
    right, so tests that need a finished session get one honestly. */
async function answerAll(env, session, { wrongItemIds = [], key = TEST_SYNC_KEY, practiceMode } = {}) {
  let latest = session;
  for (const ex of session.exercises) {
    const wrong = wrongItemIds.includes(ex.word.id);
    let answer;
    if (ex.prompt.format === "choice") {
      answer = wrong
        ? ex.prompt.options.find((o) => o !== correctChoiceFor(env, session, ex)) || ex.prompt.options[0]
        : correctChoiceFor(env, session, ex);
    } else if (ex.kind === "write_sentence") {
      answer = wrong ? "x" : "I managed to " + ex.word.english + " it in the end.";
    } else {
      answer = wrong ? "definitely-not-the-answer" : storedAnswerFor(env, session, ex).accepted[0];
    }
    const body = { exerciseId: ex.exerciseId, answer };
    if (practiceMode) body.practiceMode = practiceMode;
    const r = await call(req("POST", "/vocab/session/answer", { body, key }), env);
    assert.equal(r.res.status, 200, r.text);
    latest = r.body.session;
  }
  return latest;
}

/* The stored answer never leaves the Worker, so the test reads it from the
   database directly — exactly the access a browser does not have. */
function storedAnswerFor(env, session, ex) {
  const row = env.DB.query(
    "SELECT answer FROM vocab_exercise WHERE session_key = ? AND exercise_id = ?",
    session.sessionKey, ex.exerciseId
  )[0];
  return JSON.parse(row.answer);
}

function correctChoiceFor(env, session, ex) {
  return storedAnswerFor(env, session, ex).correctOption;
}

/* ---------------- library and manual add ---------------- */

test("a brand-new learner has an empty library rather than an error", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(req("GET", "/vocab/library"), env);
    assert.equal(res.status, 200);
    assert.deepEqual(body.items, []);
    assert.equal(body.stats.total, 0);
    assert.equal(body.stats.pending, 0);
  });
});

test("words saved through the old sync route appear in the library as unpractised", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocabulary", { body: { english: "deadline", hebrew: "מועד אחרון" } }), env);
    const { body } = await call(req("GET", "/vocab/library"), env);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].english, "deadline");
    assert.equal(body.items[0].mastery, "new");
    assert.equal(body.items[0].source, "manual");
    assert.equal(body.items[0].approval, "approved");
    assert.equal(body.items[0].isNew, true);
  });
});

test("a manual word is enriched by one AI call and saved as approved", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    const { res, body } = await call(req("POST", "/vocab/items", { body: { term: "figure out" } }), env);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.enriched, true);
    assert.equal(body.item.english, "figure out");
    assert.ok(body.item.hebrew.length > 0, "enrichment must supply a meaning");
    assert.ok(body.item.example.length > 0);
    assert.equal(body.item.source, "manual");
    assert.equal(body.item.approval, "approved");
    assert.equal(g.counts.enrichment, 1, "one enrichment call, not more");
  });
});

test("a manual word with its own Hebrew meaning needs no AI at all", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(
      req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד אחרון" } }),
      env
    );
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.enriched, false);
    assert.equal(body.item.hebrew, "מועד אחרון");
  });
});

test("the learner's own wording survives enrichment", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    const { body } = await call(
      req("POST", "/vocab/items", { body: { term: "figure out", hebrew: "לפצח", enrich: true } }),
      env
    );
    assert.equal(body.item.hebrew, "לפצח", "the model must not overwrite what the learner typed");
    assert.ok(body.item.example.length > 0, "but it should still fill the gaps");
  });
});

test("a manual word still saves when the AI is unavailable, if a meaning was given", async () => {
  const env = makeEnv();
  await withGemini(
    async () => {
      const { res, body } = await call(
        req("POST", "/vocab/items", { body: { term: "figure out", hebrew: "להבין", enrich: true } }),
        env
      );
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.enriched, false);
      assert.match(body.aiNote, /quota/i);
      assert.equal(body.item.hebrew, "להבין");
    },
    { enrichment: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) }
  );
});

test("the same word cannot be saved twice", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד אחרון" } }), env);
    const { res, body } = await call(
      req("POST", "/vocab/items", { body: { term: "  Deadline ", hebrew: "אחר" } }),
      env
    );
    assert.equal(res.status, 409);
    assert.equal(body.error, "already_saved");
  });
});

test("a word can be edited without disturbing its learning state", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(req("POST", "/vocab/items", { body: { term: "put off", hebrew: "לדחות" } }), env);
    const id = created.body.item.id;
    env.DB.exec(
      "UPDATE vocabulary_state SET mastery='strong', successes=4, intervalDays=7 WHERE id='" + id + "'"
    );

    const { res, body } = await call(
      req("POST", "/vocab/items/" + id, { body: { term: "put off", hebrew: "לדחות / לתחוב", example: "Do not put off the call." } }),
      env
    );
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.item.hebrew, "לדחות / לתחוב");
    assert.equal(body.item.mastery, "strong", "editing content must not reset mastery");
    assert.equal(body.item.successes, 4);
  });
});

/* ---------------- suggestions ---------------- */

test("a suggested word is created pending and is not active vocabulary", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", {
        body: { term: "figure out", hebrew: "להבין / לפענח", origin: "speaking", contextNote: "you paused on this" }
      }),
      env
    );
    assert.equal(created.res.status, 200, created.text);
    assert.equal(created.body.created, true);
    assert.equal(created.body.suggestion.approval, "pending");
    assert.equal(created.body.suggestion.source, "detected");

    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.length, 0, "a pending word is not active vocabulary");
    assert.equal(lib.body.pending.length, 1);
    assert.equal(lib.body.stats.total, 0);
  });
});

test("there is no way to create an already-approved detected word", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    // Every field the caller controls is passed, including hopeful ones.
    const created = await call(
      req("POST", "/vocab/suggestions", {
        body: { term: "figure out", hebrew: "להבין", approval: "approved", source: "manual" }
      }),
      env
    );
    assert.equal(created.body.suggestion.approval, "pending");
    assert.equal(created.body.suggestion.source, "detected");
  });
});

test("approving a suggestion makes it active and schedulable", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }),
      env
    );
    const id = created.body.suggestion.id;

    const approved = await call(req("POST", "/vocab/suggestions/" + id + "/approve", { body: {} }), env);
    assert.equal(approved.res.status, 200, approved.text);
    assert.equal(approved.body.item.approval, "approved");

    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.length, 1);
    assert.equal(lib.body.pending.length, 0);
    assert.equal(lib.body.stats.due, 1, "an approved word becomes due for learning");
  });
});

test("a rejected suggestion never enters daily learning and is not re-suggested", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }),
      env
    );
    const id = created.body.suggestion.id;
    const rejected = await call(req("POST", "/vocab/suggestions/" + id + "/reject", { body: {} }), env);
    assert.equal(rejected.body.approval, "rejected");

    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.length, 0);
    assert.equal(lib.body.pending.length, 0);
    assert.equal(lib.body.dismissed.length, 1, "dismissed, not destroyed");
    assert.equal(lib.body.stats.due, 0);

    // The plan must not schedule it either.
    const plan = await makePlan(env);
    const vocab = plan.activities.find((a) => a.type === "vocabulary");
    assert.equal(vocab.spec.reviewItemIds.length, 0);
    assert.equal(vocab.spec.newItemIds.length, 0);

    // And the same word offered again is refused rather than resurrected.
    const again = await call(
      req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }),
      env
    );
    assert.equal(again.body.created, false);
    assert.equal(again.body.reason, "already_known");
  });
});

test("a suggestion can only be decided once", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }),
      env
    );
    const id = created.body.suggestion.id;
    await call(req("POST", "/vocab/suggestions/" + id + "/approve", { body: {} }), env);
    const twice = await call(req("POST", "/vocab/suggestions/" + id + "/reject", { body: {} }), env);
    assert.equal(twice.res.status, 409);
    assert.equal(twice.body.error, "not_pending");
  });
});

/* ---------------- session creation and generation ---------------- */

test("a daily session refuses to invent its own plan", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
    assert.equal(res.status, 409);
    assert.equal(body.error, "no_daily_plan");
  });
});

test("the session generates exactly the number of new words the planner asked for", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    const plan = await makePlan(env, "standard");
    const requested = plan.activities.find((a) => a.type === "vocabulary").spec.newWordsToSource;
    assert.equal(requested, 5, "a Standard day with an empty library asks for five");

    const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
    assert.equal(res.status, 200, body && JSON.stringify(body));
    assert.equal(body.created, true);
    assert.equal(body.session.counts.newRequested, 5);
    assert.equal(body.session.counts.newGenerated, 5);
    assert.equal(g.counts.generation, 1, "one batch call, not five");
    assert.equal(body.aiCalls, 1);
  });
});

test("a Quick day generates fewer new words, because the planner asked for fewer", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    const plan = await makePlan(env, "quick");
    const requested = plan.activities.find((a) => a.type === "vocabulary").spec.newWordsToSource;
    assert.ok(requested < 5, "Quick must ask for fewer than the Standard default");

    const { body } = await call(req("POST", "/vocab/session", { body: {} }), env);
    assert.equal(body.session.counts.newGenerated, requested, "the session must not force five");
    assert.equal(g.counts.generation, 1);
  });
});

test("a reload does not regenerate: the second call makes no AI request at all", async () => {
  const env = makeEnv();
  let firstTerms;
  await withGemini(async (g) => {
    await makePlan(env);
    const first = await call(req("POST", "/vocab/session", { body: {} }), env);
    firstTerms = first.body.session.exercises.map((e) => e.word.english);
    assert.equal(g.counts.generation, 1);
  });

  // Second call, with the network fatal: if it tried to generate, this throws.
  await withNoNetwork(async () => {
    const second = await call(req("POST", "/vocab/session", { body: {} }), env);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.reason, "existing_session_returned");
    assert.equal(second.body.aiCalls, 0);
    assert.deepEqual(second.body.session.exercises.map((e) => e.word.english), firstTerms);
  });
});

test("the learner's second device sees the identical session", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });

  await withNoNetwork(async () => {
    // Same sync key, a separate request — that is exactly what the iPhone is.
    const phone = await call(req("GET", "/vocab/session"), env);
    const mac = await call(req("GET", "/vocab/session"), env);
    assert.equal(phone.res.status, 200);
    assert.deepEqual(
      phone.body.session.exercises.map((e) => [e.exerciseId, e.kind, JSON.stringify(e.prompt)]),
      mac.body.session.exercises.map((e) => [e.exerciseId, e.kind, JSON.stringify(e.prompt)])
    );
  });
});

test("generated words are saved as system vocabulary with their teaching detail", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });
  await withNoNetwork(async () => {
    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.stats.bySource.system, 5);
    const w = lib.body.items[0];
    assert.ok(w.example.length > 0);
    assert.ok(w.definitionEn.length > 0);
    assert.ok(w.usefulnessNoteHe.length > 0);
    assert.equal(w.register, "neutral");
    assert.equal(w.partOfSpeech, "phrasal verb");
  });
});

test("generation avoids words the learner already has", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "phrase-1", hebrew: "קיים" } }), env);
    await call(req("POST", "/vocab/items", { body: { term: "phrase-2", hebrew: "קיים" } }), env);
  });

  await withGemini(async (g) => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);

    // The prompt has to tell the model what to avoid...
    const genCall = g.calls.find((c) => /choose new English vocabulary/.test(JSON.parse(c.init.body).systemInstruction.parts[0].text));
    const userText = JSON.parse(genCall.init.body).contents[0].parts[0].text;
    assert.match(userText, /phrase-1/);
    assert.match(userText, /phrase-2/);
  });

  // ...and the code has to enforce it regardless of whether the model complied.
  // The stub deliberately returns phrase-1 and phrase-2 anyway.
  await withNoNetwork(async () => {
    const lib = await call(req("GET", "/vocab/library"), env);
    const terms = lib.body.items.map((v) => v.english);
    assert.equal(new Set(terms).size, terms.length, "duplicates reached the library: " + terms);
    assert.equal(terms.filter((t) => t === "phrase-1").length, 1);
  });
});

test("a rejected suggestion is not offered back as a generated word", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", { body: { term: "phrase-1", hebrew: "להבין" } }),
      env
    );
    await call(req("POST", "/vocab/suggestions/" + created.body.suggestion.id + "/reject", { body: {} }), env);
  });
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });
  await withNoNetwork(async () => {
    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.filter((v) => v.english === "phrase-1").length, 0);
    assert.equal(lib.body.dismissed.length, 1);
  });
});

/* ---------------- AI failure handling ---------------- */

test("a 429 degrades the session instead of breaking it", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד אחרון" } }), env);
    await call(req("POST", "/vocab/items", { body: { term: "put off", hebrew: "לדחות" } }), env);
    await call(req("POST", "/vocab/items", { body: { term: "call off", hebrew: "לבטל" } }), env);
  });

  await withGemini(
    async () => {
      await makePlan(env);
      const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.session.ai.state, "degraded");
      assert.match(body.session.ai.note, /quota/i);
      assert.ok(body.session.exercises.length > 0, "the words the learner already has still get practised");
      assert.equal(body.session.counts.newGenerated, 0);
    },
    { generation: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) }
  );
});

test("a 503 is retried, a 429 is not", async () => {
  const env = makeEnv();
  await withGemini(
    async (g) => {
      await makePlan(env);
      await call(req("POST", "/vocab/session", { body: {} }), env);
      assert.equal(g.counts.generation, 3, "a transient overload is worth retrying");
    },
    { generation: () => jsonResponse(503, { error: { status: "UNAVAILABLE", message: "high demand" } }) }
  );

  const env2 = makeEnv();
  await withGemini(
    async (g) => {
      await makePlan(env2);
      await call(req("POST", "/vocab/session", { body: {} }), env2);
      assert.equal(g.counts.generation, 1, "hammering an exhausted quota only burns more of it");
    },
    { generation: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } }) }
  );
});

test("malformed model output is rejected rather than turned into broken cards", async () => {
  const cases = [
    () => jsonResponse(200, geminiOk({ items: "not an array" })),
    () => jsonResponse(200, geminiOk({ items: [{ term: "x" }] })),
    () => jsonResponse(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] }),
    () => jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } })
  ];
  for (const generation of cases) {
    const env = makeEnv();
    await withGemini(
      async () => {
        await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד" } }), env);
        await makePlan(env);
        const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.session.counts.newGenerated, 0);
        assert.equal(body.session.ai.state, "degraded");
      },
      { generation }
    );
  }
});

test("no AI error can leak the Gemini key or the sync pepper", async () => {
  const env = makeEnv();
  await withGemini(
    async () => {
      await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד" } }), env);
      await makePlan(env);
      const { text } = await call(req("POST", "/vocab/session", { body: {} }), env);
      assert.equal(text.includes(TEST_GEMINI_KEY), false);
      assert.equal(text.includes(env.SYNC_PEPPER), false);
      assert.equal(text.includes(TEST_SYNC_KEY), false);

      const enrich = await call(req("POST", "/vocab/enrich", { body: { term: "deadline" } }), env);
      assert.equal(enrich.text.includes(TEST_GEMINI_KEY), false);
    },
    {
      generation: () =>
        jsonResponse(500, { error: { status: "INTERNAL", message: "failed with key " + TEST_GEMINI_KEY } }),
      enrichment: () =>
        jsonResponse(500, { error: { status: "INTERNAL", message: "key=" + TEST_GEMINI_KEY } })
    }
  );
});

test("the Gemini key is sent as a header and never in the URL", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
    for (const c of g.calls) {
      assert.equal(c.url.includes(TEST_GEMINI_KEY), false, "key in URL: " + c.url);
      assert.equal(c.init.headers["x-goog-api-key"], TEST_GEMINI_KEY);
    }
  });
});

test("no request enables search, grounding, tools or any paid feature", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
    await call(req("POST", "/vocab/enrich", { body: { term: "deadline" } }), env);
    assert.ok(g.calls.length > 0);
    for (const c of g.calls) {
      const payload = JSON.parse(c.init.body);
      assert.equal(payload.tools, undefined);
      assert.equal(payload.toolConfig, undefined);
      assert.equal(payload.cachedContent, undefined);
      assert.equal(payload.generationConfig.responseMimeType, "application/json");
      assert.ok(payload.generationConfig.responseSchema);
    }
  });
});

/* ---------------- answering ---------------- */

test("deterministic exercise kinds are marked with zero AI calls", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    const r = await call(req("POST", "/vocab/session", { body: {} }), env);
    session = r.body.session;
  });

  await withNoNetwork(async () => {
    for (const ex of session.exercises) {
      assert.notEqual(ex.kind, "write_sentence", "this fixture should be recognition and recall only");
      const answer = ex.prompt.format === "choice"
        ? correctChoiceFor(env, session, ex)
        : storedAnswerFor(env, session, ex).accepted[0];
      const r = await call(req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
      assert.equal(r.res.status, 200, r.text);
      assert.equal(r.body.correct, true);
      assert.equal(r.body.evaluatedBy, "deterministic");
    }
  });
});

test("a wrong answer gets the right answer and a Hebrew explanation, not just 'wrong'", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    const ex = session.exercises[0];
    const wrong = ex.prompt.options.find((o) => o !== correctChoiceFor(env, session, ex));
    const r = await call(req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: wrong } }), env);
    assert.equal(r.body.correct, false);
    assert.equal(r.body.feedback.verdict, "wrong");
    assert.equal(r.body.feedback.correctAnswer, correctChoiceFor(env, session, ex));
    assert.ok(r.body.feedback.explanationHe.length > 0);
    assert.ok(r.body.feedback.example.length > 0, "seeing the word used is what makes it stick");
  });
});

test("a correct answer is not over-explained", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });
  await withNoNetwork(async () => {
    const ex = session.exercises[0];
    const r = await call(
      req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: correctChoiceFor(env, session, ex) } }),
      env
    );
    assert.equal(r.body.feedback.verdict, "correct");
    assert.equal(r.body.feedback.correctAnswer, undefined);
    assert.equal(r.body.feedback.example, undefined);
  });
});

test("the correct answer is never sent to the browser before it is answered", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });
  await withNoNetwork(async () => {
    const { text, body } = await call(req("GET", "/vocab/session"), env);
    for (const ex of body.session.exercises) {
      assert.equal(ex.answer, undefined);
    }
    assert.equal(text.includes("\"accepted\""), false);
    assert.equal(text.includes("\"correctOption\""), false);
  });
});

test("a near miss is reported as a near miss but still counts as not knowing it", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "commitment", hebrew: "מחויבות" } }), env);
  });
  await withGemini(
    async () => {
      await makePlan(env);
      const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
      const textEx = s.exercises.find((e) => e.prompt.format === "text" && e.word.english === "commitment");
      assert.ok(textEx, "expected a typed exercise for the seeded word");
      const r = await call(
        req("POST", "/vocab/session/answer", { body: { exerciseId: textEx.exerciseId, answer: "commitement" } }),
        env
      );
      assert.equal(r.body.correct, false);
      assert.equal(r.body.feedback.verdict, "near");
    },
    { generation: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } }) }
  );
});

test("an answer can be revised and does not double-count", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });
  await withNoNetwork(async () => {
    const ex = session.exercises[0];
    const wrong = ex.prompt.options.find((o) => o !== correctChoiceFor(env, session, ex));
    await call(req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: wrong } }), env);
    const second = await call(
      req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: correctChoiceFor(env, session, ex) } }),
      env
    );
    assert.equal(second.body.correct, true);
    assert.equal(second.body.session.progress.attempted, 1, "one exercise, one attempt");
  });
});

test("answers survive a refresh, feedback and all", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });
  await withNoNetwork(async () => {
    const ex = session.exercises[0];
    await call(
      req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: correctChoiceFor(env, session, ex) } }),
      env
    );
    const reloaded = await call(req("GET", "/vocab/session"), env);
    const same = reloaded.body.session.exercises[0];
    assert.equal(same.attempted, true);
    assert.equal(same.correct, true);
    assert.equal(same.feedback.verdict, "correct");
    assert.equal(reloaded.body.session.progress.attempted, 1);
  });
});

/* ---------------- write your own sentence ---------------- */

test("writing a sentence is the only kind that calls AI, and only on submit", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }
    // Make one word mastered so Smart Mix reaches for a written sentence.
    env.DB.exec("UPDATE vocabulary_state SET mastery='mastered', successes=9, dueAt=0, lastPracticedAt=1");
  });

  await withGemini(async (g) => {
    await makePlan(env);
    const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
    const write = s.exercises.find((e) => e.kind === "write_sentence");
    assert.ok(write, "expected a write-your-own-sentence exercise: " + s.exercises.map((e) => e.kind));
    assert.equal(g.counts.writeEval, 0, "no AI is spent until the learner actually writes something");

    const r = await call(
      req("POST", "/vocab/session/answer", {
        body: { exerciseId: write.exerciseId, answer: "I finally figured out the problem." }
      }),
      env
    );
    assert.equal(r.res.status, 200, r.text);
    assert.equal(r.body.evaluatedBy, "ai");
    assert.equal(r.body.correct, true);
    assert.equal(g.counts.writeEval, 1);
  });
});

test("a misused word is marked as needing adjustment, with a Hebrew explanation", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }
    env.DB.exec("UPDATE vocabulary_state SET mastery='mastered', successes=9, dueAt=0, lastPracticedAt=1");
  });

  await withGemini(
    async () => {
      await makePlan(env);
      const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
      const write = s.exercises.find((e) => e.kind === "write_sentence");
      const r = await call(
        req("POST", "/vocab/session/answer", { body: { exerciseId: write.exerciseId, answer: "I figure out to the shop." } }),
        env
      );
      assert.equal(r.body.correct, false);
      assert.equal(r.body.feedback.verdict, "adjust");
      assert.equal(r.body.feedback.correctedSentence, "I figured out what was wrong.");
      assert.ok(r.body.feedback.explanationHe.length > 0);
    },
    {
      writeEval: () => jsonResponse(200, geminiOk({
        usedCorrectly: false,
        isNatural: false,
        correctedSentence: "I figured out what was wrong.",
        explanationHe: "הביטוי figure out לא לוקח מושא עקיף עם to.",
        betterAlternative: ""
      }))
    }
  );
});

test("when the AI cannot mark a written sentence, the learner is not blocked", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }
    env.DB.exec("UPDATE vocabulary_state SET mastery='mastered', successes=9, dueAt=0, lastPracticedAt=1");
  });

  await withGemini(
    async () => {
      await makePlan(env);
      const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
      const write = s.exercises.find((e) => e.kind === "write_sentence");
      const r = await call(
        req("POST", "/vocab/session/answer", {
          body: { exerciseId: write.exerciseId, answer: "I finally " + write.word.english + " the whole thing." }
        }),
        env
      );
      assert.equal(r.res.status, 200, r.text);
      assert.equal(r.body.evaluatedBy, "ai_unavailable");
      assert.equal(r.body.correct, true, "using the term is checkable without a model");
      assert.equal(r.body.feedback.unchecked, true);
      assert.ok(r.body.feedback.noticeHe.length > 0, "the learner must be told what was not checked");
    },
    { writeEval: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) }
  );
});

/* ---------------- completion ---------------- */

test("a session cannot be completed without doing it", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });
  await withNoNetwork(async () => {
    const { res, body } = await call(req("POST", "/vocab/session/complete", { body: {} }), env);
    assert.equal(res.status, 409);
    assert.equal(body.error, "session_incomplete");
    assert.equal(body.progress.attempted, 0);
    assert.ok(body.progress.required > 0);
    assert.ok(body.rule.length > 0);

    const plan = await call(req("GET", "/daily-plan"), env);
    const vocab = plan.body.plan.activities.find((a) => a.type === "vocabulary");
    assert.equal(vocab.status, "pending", "Today's Plan must not have been marked done");
  });
});

test("finishing the session completes the Today's Plan vocabulary activity", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    const finished = await answerAll(env, session);
    assert.equal(finished.progress.readyToComplete, true);

    const done = await call(req("POST", "/vocab/session/complete", { body: { durationSeconds: 300 } }), env);
    assert.equal(done.res.status, 200, done.text);
    assert.equal(done.body.summary.introduced.length, 5);
    assert.equal(done.body.summary.itemsCorrect, done.body.summary.itemsAttempted);

    const vocab = done.body.plan.activities.find((a) => a.type === "vocabulary");
    assert.equal(vocab.status, "complete");
    assert.ok(vocab.completedAt > 0);
  });
});

test("completion survives a refresh and is the same on the other device", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    await answerAll(env, session);
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);

    const reloaded = await call(req("GET", "/vocab/session"), env);
    assert.equal(reloaded.body.session.status, "complete");

    const plan = await call(req("GET", "/daily-plan"), env);
    assert.equal(plan.body.plan.activities.find((a) => a.type === "vocabulary").status, "complete");
  });
});

test("completing twice does not schedule every word a second time", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    await answerAll(env, session);
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);
    const before = env.DB.query("SELECT id, successes, mastery, dueAt FROM vocabulary_state ORDER BY id");

    const again = await call(req("POST", "/vocab/session/complete", { body: {} }), env);
    assert.equal(again.res.status, 200);
    assert.equal(again.body.alreadyComplete, true);

    const after = env.DB.query("SELECT id, successes, mastery, dueAt FROM vocabulary_state ORDER BY id");
    assert.deepEqual(after, before);
  });
});

test("completion applies the scheduler: right words move up, wrong words come back sooner", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    const wrongId = session.exercises[0].word.id;
    await answerAll(env, session, { wrongItemIds: [wrongId] });
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);

    const lib = await call(req("GET", "/vocab/library"), env);
    const failed = lib.body.items.find((v) => v.id === wrongId);
    const passed = lib.body.items.find((v) => v.id !== wrongId);

    assert.equal(failed.mastery, "new", "a word got wrong does not climb the ladder");
    assert.equal(failed.failures, 1);
    assert.equal(passed.mastery, "learning");
    assert.ok(failed.dueAt < passed.dueAt, "the failed word must come back first");
  });
});

test("one wrong answer about a word outweighs a right one in the same session", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    // Each new word gets two questions today; get exactly one of them wrong.
    const target = session.exercises[0].word.id;
    const forTarget = session.exercises.filter((e) => e.word.id === target);
    assert.equal(forTarget.length, 2, "expected recognition plus recall for a new word");

    for (const ex of session.exercises) {
      const isFirstForTarget = ex.exerciseId === forTarget[0].exerciseId;
      const answer = ex.prompt.format === "choice"
        ? (isFirstForTarget
            ? ex.prompt.options.find((o) => o !== correctChoiceFor(env, session, ex))
            : correctChoiceFor(env, session, ex))
        : (isFirstForTarget ? "wrong-answer" : storedAnswerFor(env, session, ex).accepted[0]);
      await call(req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
    }
    const done = await call(req("POST", "/vocab/session/complete", { body: {} }), env);
    assert.equal(done.res.status, 200, done.text);

    const lib = await call(req("GET", "/vocab/library"), env);
    const item = lib.body.items.find((v) => v.id === target);
    assert.equal(item.mastery, "new");
    assert.equal(item.failures, 1);
    assert.deepEqual(done.body.summary.needsReview.map((v) => v.id), [target]);
  });
});

test("the completion writes a summary that survives a session-mode change", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env, "standard");
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    await answerAll(env, session);
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);

    // Switching to Quick rebuilds the plan. The vocabulary work must stay done,
    // and the words the learner learned must keep their evidence.
    const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
    assert.equal(quick.body.plan.mode, "quick");
    assert.equal(quick.body.plan.activities.find((a) => a.type === "vocabulary").status, "complete");

    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.length, 5);
    for (const v of lib.body.items) {
      assert.equal(v.mastery, "learning", "a replan must not erase learning evidence");
      assert.equal(v.successes, 1);
    }

    const back = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
    assert.equal(back.body.plan.activities.find((a) => a.type === "vocabulary").status, "complete");
  });
});

/* ---------------- focused practice ---------------- */

test("a focused mode runs from the library without a daily plan and adds no new words", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [["deadline", "מועד אחרון"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }

    const { res, body } = await call(req("POST", "/vocab/session", { body: { practiceMode: "he_en" } }), env);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.aiCalls, 0, "a focused deterministic mode is free");
    assert.equal(body.session.practiceMode, "he_en");
    assert.equal(body.session.counts.new, 0, "focused practice never introduces new words");
    for (const ex of body.session.exercises) assert.equal(ex.kind, "he_en");
  });
});

test("a focused session is separate from the daily one and does not complete the plan", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });

  await withNoNetwork(async () => {
    const focused = await call(req("POST", "/vocab/session", { body: { practiceMode: "en_he" } }), env);
    assert.equal(focused.res.status, 200, focused.text);
    assert.notEqual(focused.body.session.sessionKey, todayKey());
    assert.equal(focused.body.session.activityId, null);

    await answerAll(env, focused.body.session, { practiceMode: "en_he" });
    const done = await call(req("POST", "/vocab/session/complete", { body: { practiceMode: "en_he" } }), env);
    assert.equal(done.res.status, 200, done.text);
    assert.equal(done.body.plan, null, "focused practice is not the daily lesson");

    const plan = await call(req("GET", "/daily-plan"), env);
    assert.equal(plan.body.plan.activities.find((a) => a.type === "vocabulary").status, "pending");
  });
});

test("an unknown practice mode is refused", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(req("POST", "/vocab/session", { body: { practiceMode: "telepathy" } }), env);
    assert.equal(res.status, 400);
    assert.equal(body.field, "practiceMode");
  });
});

/* ---------------- AI usage accounting ---------------- */

test("every AI call is recorded under a purpose that names what it was for", async () => {
  const env = makeEnv();
  await withGemini(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "figure out" } }), env);
    await makePlan(env);
    await call(req("POST", "/vocab/session", { body: {} }), env);
  });

  await withNoNetwork(async () => {
    const usage = await call(req("GET", "/ai/usage"), env);
    const purposes = usage.body.usage.map((u) => u.purpose);
    assert.ok(purposes.includes("vocabulary_enrichment"), purposes.join(","));
    assert.ok(purposes.includes("vocabulary_generation"), purposes.join(","));
    for (const row of usage.body.usage) {
      assert.equal(String(row.model).includes(TEST_GEMINI_KEY), false);
    }
    assert.match(usage.body.note, /does not model or enforce/i);
  });
});

test("a whole day of vocabulary costs a small, countable number of AI calls", async () => {
  const env = makeEnv();
  await withGemini(async (g) => {
    await makePlan(env);
    const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
    await answerAll(env, s);
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);
    assert.ok(g.calls.length <= 2, "a full session should not exceed two AI calls here, got " + g.calls.length);
    assert.equal(g.counts.generation, 1);
  });
});

/* ---------------- owner isolation ---------------- */

test("nothing about one learner's vocabulary is reachable with another key", async () => {
  const env = makeEnv();
  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
    await call(req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }), env);
  });

  await withNoNetwork(async () => {
    const lib = await call(req("GET", "/vocab/library", { key: OTHER_KEY }), env);
    assert.equal(lib.body.items.length, 0);
    assert.equal(lib.body.pending.length, 0);

    const sess = await call(req("GET", "/vocab/session", { key: OTHER_KEY }), env);
    assert.equal(sess.body.exists, false);
    assert.equal(sess.body.session, null);

    // Knowing the exercise id is not enough.
    const answer = await call(
      req("POST", "/vocab/session/answer", {
        body: { exerciseId: session.exercises[0].exerciseId, answer: "anything" },
        key: OTHER_KEY
      }),
      env
    );
    assert.equal(answer.res.status, 404);

    const complete = await call(req("POST", "/vocab/session/complete", { body: {}, key: OTHER_KEY }), env);
    assert.equal(complete.res.status, 404);
  });
});

test("suggestions cannot be approved across owners", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(
      req("POST", "/vocab/suggestions", { body: { term: "figure out", hebrew: "להבין" } }),
      env
    );
    const id = created.body.suggestion.id;
    const foreign = await call(req("POST", "/vocab/suggestions/" + id + "/approve", { body: {}, key: OTHER_KEY }), env);
    assert.equal(foreign.res.status, 404);

    const mine = await call(req("GET", "/vocab/suggestions"), env);
    assert.equal(mine.body.pending[0].approval, "pending", "it must still be waiting for its real owner");
  });
});

test("editing another owner's word is a 404, not a rewrite", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const created = await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד" } }), env);
    const id = created.body.item.id;
    const foreign = await call(
      req("POST", "/vocab/items/" + id, { body: { term: "hacked", hebrew: "פרוץ" }, key: OTHER_KEY }),
      env
    );
    assert.equal(foreign.res.status, 404);
    const still = await call(req("GET", "/vocab/library"), env);
    assert.equal(still.body.items[0].english, "deadline");
  });
});

/* ---------------- auth, CORS, validation ---------------- */

test("every vocabulary route requires a sync key", async () => {
  const env = makeEnv();
  const paths = [
    ["GET", "/vocab/library"],
    ["POST", "/vocab/items"],
    ["POST", "/vocab/enrich"],
    ["GET", "/vocab/suggestions"],
    ["POST", "/vocab/suggestions"],
    ["GET", "/vocab/session"],
    ["POST", "/vocab/session"],
    ["POST", "/vocab/session/answer"],
    ["POST", "/vocab/session/complete"],
    ["GET", "/vocab/config"]
  ];
  await withNoNetwork(async () => {
    for (const [method, path] of paths) {
      const r = await call(req(method, path, { body: method === "POST" ? {} : undefined, key: null }), env);
      assert.equal(r.res.status, 401, method + " " + path + " was not 401");
    }
  });
});

test("a foreign origin is refused before anything is read", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const r = await call(req("GET", "/vocab/library", { origin: "https://evil.example" }), env);
    assert.equal(r.res.status, 403);
    assert.equal(r.body.error, "origin_not_allowed");
  });
});

test("the allowed origin gets CORS headers on the vocabulary routes too", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const r = await call(req("GET", "/vocab/library", { origin: TEST_ORIGIN }), env);
    assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);
    assert.match(r.res.headers.get("Access-Control-Allow-Headers"), /X-Sync-Key/);
  });
});

test("the /vocab namespace does not shadow the record-level sync routes", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const saved = await call(req("POST", "/vocabulary", { body: { english: "deadline", hebrew: "מועד" } }), env);
    const id = saved.body.record.id;
    const deleted = await call(req("DELETE", "/vocabulary/" + id), env);
    assert.equal(deleted.res.status, 200);
    assert.equal(deleted.body.deleted, 1);
  });
});

test("input is validated before anything is written", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const cases = [
      ["/vocab/items", { hebrew: "מועד" }, "term"],
      ["/vocab/items", { term: "x".repeat(200), hebrew: "מועד" }, "term"],
      ["/vocab/items", { term: "deadline", hebrew: "מ".repeat(500) }, "hebrew"],
      ["/vocab/enrich", {}, "term"],
      ["/vocab/session/answer", { exerciseId: "x" }, "answer"],
      ["/vocab/session/answer", { exerciseId: "x", answer: "y".repeat(400) }, "answer"]
    ];
    for (const [path, body, field] of cases) {
      const r = await call(req("POST", path, { body }), env);
      assert.equal(r.res.status, 400, path + " " + JSON.stringify(body));
      assert.equal(r.body.field, field);
    }
    const lib = await call(req("GET", "/vocab/library"), env);
    assert.equal(lib.body.items.length, 0, "a rejected request must write nothing");
  });
});

test("the vocabulary config describes the modes and the review rules honestly", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(req("GET", "/vocab/config"), env);
    assert.equal(res.status, 200);
    const ids = body.practiceModes.map((m) => m.id);
    assert.deepEqual(ids, ["smart_mix", "en_he", "he_en", "fill_blank", "meaning_context", "write_sentence"]);

    const enHe = body.practiceModes.find((m) => m.id === "en_he");
    assert.equal(enHe.usesAiForContent, false);
    assert.equal(enHe.usesAiForMarking, false);
    const write = body.practiceModes.find((m) => m.id === "write_sentence");
    assert.equal(write.usesAiForMarking, true);

    assert.match(body.reviewRules.decidedBy, /no AI/i);
    assert.deepEqual(body.sources, ["manual", "system", "detected"]);
  });
});

/* ---------------- planner is still AI-free ---------------- */

test("planning still makes zero AI calls, even with vocabulary in play", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד" } }), env);
    for (const mode of ["quick", "standard", "full"]) {
      const r = await call(req("POST", "/daily-plan", { body: { mode, replan: true } }), env);
      assert.equal(r.res.status, 200, r.text);
      assert.equal(r.body.plan.generator, "deterministic-v1");
    }
    const health = await call(req("GET", "/health", { key: null }), env);
    assert.equal(health.body.planner.usesAi, false);
  });
});

/* ---------------- migration safety ---------------- */

test("the learner's pre-existing words are untouched by everything above", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    await call(req("POST", "/vocabulary", { body: { id: "legacy-1", english: "deadline", hebrew: "מועד אחרון" } }), env);
  });
  const before = env.DB.query("SELECT * FROM vocabulary WHERE id = 'legacy-1'")[0];

  await withGemini(async () => {
    await makePlan(env);
    const s = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
    await answerAll(env, s);
    await call(req("POST", "/vocab/session/complete", { body: {} }), env);
  });

  const after = env.DB.query("SELECT * FROM vocabulary WHERE id = 'legacy-1'")[0];
  assert.equal(after.english, before.english);
  assert.equal(after.hebrew, before.hebrew);
  assert.equal(after.createdAt, before.createdAt);
});

/* ---------------- meaning in context (the batched AI exercise) ---------------- */

test("context questions for a whole session are fetched in ONE request", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [
      ["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"],
      ["look into", "לבדוק"], ["bring up", "להעלות"]
    ]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he, example: "Please " + term + " it today." } }), env);
    }
    // Established words are the ones Smart Mix asks in context.
    env.DB.exec("UPDATE vocabulary_state SET mastery='strong', successes=6, dueAt=0, lastPracticedAt=1");
  });

  await withGemini(async (g) => {
    await makePlan(env);
    const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
    assert.equal(res.status, 200, JSON.stringify(body));

    const context = body.session.exercises.filter((e) => e.kind === "meaning_context");
    assert.ok(context.length >= 2, "expected several context questions: " + body.session.exercises.map((e) => e.kind));
    assert.equal(g.counts.context, 1, "several questions, one request");

    for (const ex of context) {
      assert.equal(ex.contentFrom, "gemini");
      assert.equal(ex.prompt.options.length, 4);
      assert.ok(ex.prompt.question.length > 0);
    }
  });
});

test("a context question is marked without any further AI call", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [
      ["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]
    ]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he, example: "Please " + term + " it today." } }), env);
    }
    env.DB.exec("UPDATE vocabulary_state SET mastery='strong', successes=6, dueAt=0, lastPracticedAt=1");
  });

  let session;
  await withGemini(async () => {
    await makePlan(env);
    session = (await call(req("POST", "/vocab/session", { body: {} }), env)).body.session;
  });

  await withNoNetwork(async () => {
    const ex = session.exercises.find((e) => e.kind === "meaning_context");
    assert.ok(ex);
    const r = await call(
      req("POST", "/vocab/session/answer", { body: { exerciseId: ex.exerciseId, answer: correctChoiceFor(env, session, ex) } }),
      env
    );
    assert.equal(r.body.correct, true);
    assert.equal(r.body.evaluatedBy, "deterministic", "AI wrote the question; ordinary code marks it");
  });
});

test("when context questions fail, the session falls back to the free exercise kinds", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [
      ["figure out", "להבין"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]
    ]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he, example: "Please " + term + " it today." } }), env);
    }
    env.DB.exec("UPDATE vocabulary_state SET mastery='strong', successes=6, dueAt=0, lastPracticedAt=1");
  });

  await withGemini(
    async () => {
      await makePlan(env);
      const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.session.exercises.filter((e) => e.kind === "meaning_context").length, 0);
      assert.ok(body.session.exercises.length > 0, "the session still happens");
      assert.equal(body.session.ai.state, "degraded");
      for (const e of body.session.exercises) assert.equal(e.contentFrom, "local");
    },
    { context: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) }
  );
});

test("focused practice is worth doing even when nothing is due", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    for (const [term, he] of [["deadline", "מועד"], ["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }
    // Everything already scheduled far into the future: nothing is due.
    env.DB.exec("UPDATE vocabulary_state SET mastery='strong', successes=4, lastPracticedAt=1, dueAt=" + (Date.now() + 7 * 86400000));

    const { res, body } = await call(req("POST", "/vocab/session", { body: { practiceMode: "he_en" } }), env);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.session.counts.review, 4, "a caught-up learner still gets a real session");
    assert.equal(body.aiCalls, 0, "a focused deterministic mode must not fetch content it cannot show");
  });
});

test("focused practice puts what is due first", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const soon = await call(req("POST", "/vocab/items", { body: { term: "deadline", hebrew: "מועד" } }), env);
    for (const [term, he] of [["put off", "לדחות"], ["call off", "לבטל"], ["look into", "לבדוק"]]) {
      await call(req("POST", "/vocab/items", { body: { term, hebrew: he } }), env);
    }
    env.DB.exec("UPDATE vocabulary_state SET lastPracticedAt=1, dueAt=" + (Date.now() + 7 * 86400000));
    env.DB.exec("UPDATE vocabulary_state SET dueAt=0 WHERE id='" + soon.body.item.id + "'");

    const { body } = await call(req("POST", "/vocab/session", { body: { practiceMode: "he_en" } }), env);
    assert.equal(body.session.exercises[0].word.english, "deadline");
  });
});

test("an exhausted quota with an empty library says so, instead of blaming the learner", async () => {
  const env = makeEnv();
  await withGemini(
    async () => {
      await makePlan(env);
      const { res, body } = await call(req("POST", "/vocab/session", { body: {} }), env);
      assert.equal(res.status, 409);
      assert.equal(body.error, "new_words_unavailable");
      assert.equal(body.aiState, "degraded");
      assert.match(body.message, /quota/i);
      assert.match(body.message, /My words/, "the learner is told what they can still do");
    },
    { generation: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) }
  );
});
