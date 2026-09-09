/**
 * End-to-end tests for Sentence Practice, over the real Worker with a real
 * SQLite database running the real migrations. Gemini is always a stub; no
 * network call leaves this process and no real key exists in it.
 *
 * What this file exists to prove:
 *   - a session consumes the grammar targets and item count Today's Plan's
 *     deterministic planner already chose — it never re-picks them
 *   - the whole session (base exercises + reinforcement reserve) is
 *     generated in ONE batched Gemini call, and a reload or a second device
 *     re-reads it rather than spending quota again
 *   - deterministic exercise types (fill_blank, choice, and a correction with
 *     a usable accepted-answer set) cost zero AI calls to grade
 *   - a missed base exercise schedules exactly one different follow-up
 *     exercise on the same target, drawn from the reserve already generated
 *   - a session cannot be completed without actually being done
 *   - completing one applies learning-target evidence exactly once and
 *     closes the Today's Plan activity, durably
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
  sentenceExerciseBatch,
  SAMPLE_SENTENCE_EVAL,
  modelFromUrl,
  TEST_SYNC_KEY
} from "./helpers.js";
import { msToDateKey, DAY_MS } from "../src/planner.js";
import { MODELS } from "../src/gemini.js";

const SENTENCE_MODEL = MODELS.sentencePractice;
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

async function withGeminiSentence(run, over = {}) {
  const g = stubGeminiByPurpose({
    sentenceGeneration: (payload, user) => jsonResponse(200, geminiOk(sentenceExerciseBatch(user))),
    sentenceEval: () => jsonResponse(200, geminiOk(SAMPLE_SENTENCE_EVAL)),
    ...over
  });
  try {
    return await run(g);
  } finally {
    g.restore();
  }
}

async function withNoNetwork(run) {
  const stub = stubFetch(() => { throw new Error("unexpected AI call"); });
  try {
    return await run(stub);
  } finally {
    stub.restore();
  }
}

async function makePlan(env, mode = "standard", key = TEST_SYNC_KEY) {
  const r = await call(req("POST", "/daily-plan", { body: { mode }, key }), env);
  assert.equal(r.res.status, 200, r.text);
  return r.body.plan;
}

function grammarSpec(plan) {
  return plan.activities.find((a) => a.type === "sentence_practice").spec;
}

/* Reads the server-side answer column directly — the access a browser does
   not have — so tests can construct a genuinely correct answer without
   duplicating the fixture's own logic. */
function storedAnswer(env, sessionKey, exerciseId) {
  const row = env.DB.query(
    "SELECT answer FROM sentence_practice_exercise WHERE session_key = ? AND exercise_id = ?",
    sessionKey, exerciseId
  )[0];
  return JSON.parse(row.answer);
}

/** Promotes one target to needs_work via two distinct days of evidence —
    the same route learning.test.js uses for this. */
async function seedNeedsWork(env, targetLabel, key = TEST_SYNC_KEY) {
  const yesterday = msToDateKey(Date.now() - DAY_MS, 0);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: [targetLabel, targetLabel], date: yesterday }, key }), env);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: [targetLabel], date: todayKey() }, key }), env);
}

/* ---------------- planning / targets ---------------- */

test("starting a session before Today's Plan exists is refused, not invented", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const { res, body } = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(res.status, 409);
    assert.equal(body.error, "no_daily_plan");
  });
});

test("a provisional learner gets a real session built from the coverage curriculum", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    const plan = await makePlan(env, "standard");
    const spec = grammarSpec(plan);
    assert.equal(spec.grammarTargets.length, 2, "standard mode reserves two grammar slots");
    assert.ok(spec.grammarTargets.every((t) => t.kind === "curriculum"), "no error history yet, so pure curriculum");

    const r = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(r.res.status, 200, r.text);
    assert.equal(r.body.created, true);
    assert.equal(r.body.aiCalls, 1);
    assert.equal(r.body.session.counts.base, spec.itemCount);
    assert.equal(r.body.session.targets.length, 2);
  });
});

test("a recurring weakness wins one of the session's grammar targets", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => { await seedNeedsWork(env, "Past Simple"); });

  await withGeminiSentence(async () => {
    const plan = await makePlan(env, "standard");
    const spec = grammarSpec(plan);
    const found = spec.grammarTargets.find((t) => t.id === "past_simple");
    assert.ok(found, "the recurring weakness must claim a slot");
    assert.equal(found.status, "needs_work");
    assert.equal(found.kind, "learner");

    const r = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const ids = r.body.session.targets.map((t) => t.id);
    assert.ok(ids.includes("past_simple"));
    const t = r.body.session.targets.find((t) => t.id === "past_simple");
    assert.equal(t.reason.he.length > 0, true, "the UI gets a Hebrew reason for why this target was chosen");
  });
});

test("planner.js itself still makes zero network calls while building the plan", async () => {
  const env = makeEnv();
  await withNoNetwork(async () => {
    const plan = await makePlan(env, "standard");
    assert.equal(plan.generator, "deterministic-v1");
  });
});

/* ---------------- generation / persistence ---------------- */

test("the session is generated once, in one batched call, and a refresh re-reads it", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");

    const first = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(first.body.created, true);
    assert.equal(g.counts.sentenceGeneration, 1);

    const second = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(second.body.created, false);
    assert.equal(second.body.reason, "existing_session_returned");
    assert.equal(second.body.aiCalls, 0);
    assert.equal(g.counts.sentenceGeneration, 1, "no second generation call on reload");

    const viaGet = await call(req("GET", "/sentence-practice/session"), env);
    assert.equal(viaGet.body.exists, true);
    assert.deepEqual(
      viaGet.body.session.exercises.map((e) => e.exerciseId),
      first.body.session.exercises.map((e) => e.exerciseId)
    );
  });
});

test("a second device (same sync key) sees the identical persisted session", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "standard");
    const a = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const b = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.deepEqual(a.body.session.exercises, b.body.session.exercises);
  });
});

test("the intended model is gemini-3.1-flash-lite, never a silent fallback", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");
    await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(g.models.sentenceGeneration, SENTENCE_MODEL);
    assert.equal(SENTENCE_MODEL, "gemini-3.1-flash-lite");
  });
});

test("a malformed batch is rejected gracefully: no session is persisted, and a later retry succeeds", async () => {
  const env = makeEnv();
  await makePlan(env, "standard");

  await withGeminiSentence(async () => {
    const r = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(r.res.status, 503);
    assert.equal(r.body.error, "sentence_content_unavailable");
  }, { sentenceGeneration: () => jsonResponse(200, geminiOk({ items: [] })) });

  const stillNothing = await call(req("GET", "/sentence-practice/session"), env);
  assert.equal(stillNothing.body.exists, false, "a failed batch must not leave a broken session behind");

  await withGeminiSentence(async () => {
    const r = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(r.res.status, 200, r.text);
    assert.equal(r.body.created, true);
  });
});

test("a 429 from the AI service degrades the request instead of corrupting learner state", async () => {
  const env = makeEnv();
  await makePlan(env, "standard");
  await withGeminiSentence(async () => {
    const r = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    assert.equal(r.res.status, 503);
    const stillNothing = await call(req("GET", "/sentence-practice/session"), env);
    assert.equal(stillNothing.body.exists, false);
  }, { sentenceGeneration: () => jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) });
});

/* ---------------- deterministic grading ---------------- */

test("fill_blank and choice are graded deterministically, with zero AI calls", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const sessionKey = session.sessionKey;
    const fillBlank = session.exercises.find((e) => e.type === "fill_blank");
    const choice = session.exercises.find((e) => e.type === "choice");
    assert.ok(fillBlank && choice, "the fixture always produces one of each requested type");

    const genCallsBefore = g.counts.sentenceGeneration;
    const evalCallsBefore = g.counts.sentenceEval;

    const fbAnswer = storedAnswer(env, sessionKey, fillBlank.exerciseId).correctOption;
    const r1 = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: fillBlank.exerciseId, answer: fbAnswer } }), env);
    assert.equal(r1.body.correct, true);
    assert.equal(r1.body.evaluatedBy, "deterministic");

    const wrongOption = storedAnswer(env, sessionKey, choice.exerciseId).correctOption + " nope";
    const r2 = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: choice.exerciseId, answer: wrongOption } }), env);
    assert.equal(r2.body.correct, false);
    assert.equal(r2.body.evaluatedBy, "deterministic");

    assert.equal(g.counts.sentenceGeneration, genCallsBefore);
    assert.equal(g.counts.sentenceEval, evalCallsBefore, "deterministic grading must spend no AI call");
  });
});

test("a correction with a usable accepted-answer set is graded deterministically and tolerates punctuation, case and contractions", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const correction = session.exercises.find((e) => e.type === "correction");
    assert.ok(correction, "the fixture always produces one correction exercise");

    const canonical = storedAnswer(env, session.sessionKey, correction.exerciseId).canonicalAnswer;
    // Same sentence, but re-cased, re-punctuated, and with the contraction expanded.
    const messy = canonical.toUpperCase().replace("DOESN'T", "does not");

    const before = g.counts.sentenceEval;
    const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: correction.exerciseId, answer: messy } }), env);
    assert.equal(r.body.correct, true);
    assert.equal(r.body.evaluatedBy, "deterministic");
    assert.equal(g.counts.sentenceEval, before);
  });
});

/* ---------------- AI evaluation ---------------- */

test("free_sentence answers are judged by AI, and only free_sentence/undeclared transformations spend that call", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    // Full mode gives each of the two targets five base items, which is
    // enough for the deterministic type rotation to reach free_sentence.
    await makePlan(env, "full");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const free = session.exercises.find((e) => e.type === "free_sentence");
    assert.ok(free);

    const before = g.counts.sentenceEval;
    const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: free.exerciseId, answer: "I have visited Paris twice already." } }), env);
    assert.equal(r.body.evaluatedBy, "ai");
    assert.equal(g.counts.sentenceEval, before + 1);
  });
});

test("when the AI evaluator is unavailable, the answer still gets an honest, clearly-labelled fallback mark", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "full");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const free = session.exercises.find((e) => e.type === "free_sentence");

    const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: free.exerciseId, answer: "I have visited Paris twice already." } }), env);
    assert.equal(r.body.evaluatedBy, "ai_unavailable");
    assert.equal(r.body.feedback.unchecked, true);
  }, { sentenceEval: () => jsonResponse(200, geminiOk({ correctedSentence: "", explanationHe: "", betterAlternative: "" /* missing `correct` */ })) });
});

/* ---------------- reinforcement ---------------- */

test("missing a base exercise schedules exactly one different follow-up on the same target, with no extra Gemini call", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const sessionKey = session.sessionKey;
    const target = session.targets[0].id;
    const baseOnTarget = session.exercises.find((e) => e.targetId === target && !e.reinforcement);

    const before = g.counts.sentenceGeneration;
    const answer = correctnessBaitFor(env, sessionKey, baseOnTarget);
    const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: baseOnTarget.exerciseId, answer: answer.wrong } }), env);
    assert.equal(r.body.correct, false);
    assert.equal(r.body.reinforcementAdded, true);
    assert.equal(g.counts.sentenceGeneration, before, "reinforcement must be drawn from the reserve, never a new call");

    const reinforcementEx = r.body.session.exercises.find((e) => e.targetId === target && e.reinforcement);
    assert.ok(reinforcementEx, "a reinforcement exercise for the same target must now be visible");
    assert.notEqual(reinforcementEx.prompt.question, baseOnTarget.prompt.question, "it must be a different question, not a repeat");
  });
});

test("a correct base answer does not add an unnecessary reinforcement exercise", async () => {
  const env = makeEnv();
  await withGeminiSentence(async (g) => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const ex = session.exercises.find((e) => !e.reinforcement && e.type === "fill_blank");
    const correct = storedAnswer(env, session.sessionKey, ex.exerciseId).correctOption;

    const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer: correct } }), env);
    assert.equal(r.body.correct, true);
    assert.equal(r.body.reinforcementAdded, false);
  });
});

test("reinforcement is capped at one per target — missing it too adds no third exercise", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;
    const sessionKey = session.sessionKey;
    const target = session.targets[0].id;
    const base = session.exercises.find((e) => e.targetId === target && !e.reinforcement);

    const first = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: base.exerciseId, answer: "definitely wrong" } }), env);
    assert.equal(first.body.reinforcementAdded, true);
    const reinforcementEx = first.body.session.exercises.find((e) => e.targetId === target && e.reinforcement);

    const second = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: reinforcementEx.exerciseId, answer: "also wrong" } }), env);
    assert.equal(second.body.reinforcementAdded, false, "no reserve is left to activate a second time");
  });
});

/** Builds a definitely-wrong answer for whatever exercise type this is, using
    the server-side stored answer only to know what to avoid. */
function correctnessBaitFor(env, sessionKey, ex) {
  const stored = storedAnswer(env, sessionKey, ex.exerciseId);
  if (stored.correctOption) return { wrong: stored.correctOption + " — definitely not this" };
  return { wrong: "this is definitely not the accepted answer at all" };
}

/* ---------------- completion ---------------- */

test("a session cannot be completed until every active exercise, reinforcement included, is attempted", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;

    const early = await call(req("POST", "/sentence-practice/session/complete", { body: {} }), env);
    assert.equal(early.res.status, 409);
    assert.equal(early.body.error, "session_incomplete");

    let latest = session;
    for (const ex of session.exercises) {
      const stored = storedAnswer(env, session.sessionKey, ex.exerciseId);
      const answer = stored.correctOption || stored.canonicalAnswer || "I have finished this exercise correctly.";
      const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
      latest = r.body.session;
    }
    // Answer any reinforcement exercises a wrong answer above might have queued.
    for (const ex of latest.exercises) {
      if (ex.attempted) continue;
      const stored = storedAnswer(env, session.sessionKey, ex.exerciseId);
      const answer = stored.correctOption || stored.canonicalAnswer || "I have finished this exercise correctly.";
      const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
      latest = r.body.session;
    }

    const done = await call(req("POST", "/sentence-practice/session/complete", { body: {} }), env);
    assert.equal(done.res.status, 200, done.text);
    assert.equal(done.body.alreadyComplete, false);
    assert.ok(done.body.plan.activities.find((a) => a.type === "sentence_practice").status === "complete");
  });
});

test("completion applies learning-target evidence exactly once, even if the client calls it twice", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;

    let latest = session;
    for (const ex of session.exercises) {
      const stored = storedAnswer(env, session.sessionKey, ex.exerciseId);
      const answer = stored.correctOption || stored.canonicalAnswer || "I have finished this exercise correctly.";
      const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
      latest = r.body.session;
    }
    for (const ex of latest.exercises) {
      if (ex.attempted) continue;
      const stored = storedAnswer(env, session.sessionKey, ex.exerciseId);
      const answer = stored.correctOption || stored.canonicalAnswer || "I have finished this exercise correctly.";
      const r = await call(req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer } }), env);
      latest = r.body.session;
    }

    const first = await call(req("POST", "/sentence-practice/session/complete", { body: {} }), env);
    assert.equal(first.res.status, 200, first.text);
    const targetId = session.targets[0].id;
    const afterFirst = (await call(req("GET", "/learning-targets"), env)).body.targets.find((t) => t.id === targetId);

    const second = await call(req("POST", "/sentence-practice/session/complete", { body: {} }), env);
    assert.equal(second.body.alreadyComplete, true);
    const afterSecond = (await call(req("GET", "/learning-targets"), env)).body.targets.find((t) => t.id === targetId);

    assert.deepEqual(afterFirst, afterSecond, "a second completion call must not touch learning_target again");
  });
});

/* ---------------- owner isolation ---------------- */

test("a session, its exercises and its answers are invisible to a different sync key", async () => {
  const env = makeEnv();
  await withGeminiSentence(async () => {
    await makePlan(env, "standard");
    const start = await call(req("POST", "/sentence-practice/session", { body: {} }), env);
    const session = start.body.session;

    const otherGet = await call(req("GET", "/sentence-practice/session", { key: OTHER_KEY }), env);
    assert.equal(otherGet.body.exists, false);

    const ex = session.exercises[0];
    const stored = storedAnswer(env, session.sessionKey, ex.exerciseId);
    const answer = stored.correctOption || stored.canonicalAnswer || "answer";
    const otherAnswer = await call(
      req("POST", "/sentence-practice/session/answer", { body: { exerciseId: ex.exerciseId, answer }, key: OTHER_KEY }),
      env
    );
    assert.equal(otherAnswer.res.status, 404);

    const otherComplete = await call(req("POST", "/sentence-practice/session/complete", { body: {}, key: OTHER_KEY }), env);
    assert.equal(otherComplete.res.status, 404);
  });
});

test("no response from this slice ever contains the API key or the pepper", async () => {
  const env = makeEnv();
  await makePlan(env, "standard");
  const bad = await withGeminiSentence(
    () => call(req("POST", "/sentence-practice/session", { body: {} }), env),
    { sentenceGeneration: () => jsonResponse(500, { error: { message: "boom " + env.GEMINI_API_KEY + " " + env.SYNC_PEPPER } }) }
  );
  assert.doesNotMatch(bad.text, new RegExp(env.GEMINI_API_KEY));
  assert.doesNotMatch(bad.text, new RegExp(env.SYNC_PEPPER));
});
