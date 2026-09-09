/**
 * Pure-logic tests for src/sentence_practice.js: no D1, no network, no clock —
 * the same discipline planner.test.js and vocabulary.test.js hold this file to,
 * because sentence_practice.js is itself I/O-free.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  EXERCISE_TYPES,
  evaluationForExercise,
  planSlots,
  RESERVE_PER_TARGET,
  REINFORCEMENT_CAP_PER_TARGET,
  findReserveExercise,
  reinforcementActivatedCount,
  checkOptionAnswer,
  checkSentenceAnswer,
  normalizeContractions,
  evaluateCompletion,
  summariseSession
} from "../src/sentence_practice.js";

const PAST = { id: "past_simple", label: "Past Simple", status: "needs_work", kind: "learner" };
const ARTICLES = { id: "articles", label: "Articles", status: "observed", kind: "curriculum" };

/* ---------------- slot planning ---------------- */

test("planSlots splits items evenly across targets and adds one reserve per target", () => {
  const slots = planSlots([PAST, ARTICLES], 6);
  const base = slots.filter((s) => s.pool === "base");
  const reserve = slots.filter((s) => s.pool === "reserve");

  assert.equal(base.length, 6);
  assert.equal(reserve.length, 2 * RESERVE_PER_TARGET);
  assert.equal(base.filter((s) => s.target_id === "past_simple").length, 3);
  assert.equal(base.filter((s) => s.target_id === "articles").length, 3);
  assert.equal(reserve.filter((s) => s.target_id === "past_simple").length, RESERVE_PER_TARGET);
});

test("planSlots gives the remainder to the earlier target, deterministically", () => {
  const slots = planSlots([PAST, ARTICLES], 5);
  const base = slots.filter((s) => s.pool === "base");
  assert.equal(base.filter((s) => s.target_id === "past_simple").length, 3);
  assert.equal(base.filter((s) => s.target_id === "articles").length, 2);

  // Same inputs, same output — no Math.random, no Date.now anywhere in this file.
  const again = planSlots([PAST, ARTICLES], 5);
  assert.deepEqual(slots, again);
});

test("a single target still gets a reserve slot, and requested types vary rather than repeating", () => {
  const slots = planSlots([PAST], 4);
  const base = slots.filter((s) => s.pool === "base");
  assert.equal(base.length, 4);
  assert.equal(slots.filter((s) => s.pool === "reserve").length, 1);
  const types = new Set(base.map((s) => s.requestedType));
  assert.ok(types.size > 1, "four base items on one target should not all request the same type");
  for (const s of slots) assert.ok(EXERCISE_TYPES.includes(s.requestedType));
});

test("no targets means no slots, rather than a broken plan", () => {
  assert.deepEqual(planSlots([], 6), []);
  assert.deepEqual(planSlots(null, 6), []);
});

/* ---------------- deterministic vs AI evaluation split ---------------- */

test("fill_blank and choice are always deterministic", () => {
  assert.equal(evaluationForExercise("fill_blank", {}), "deterministic");
  assert.equal(evaluationForExercise("choice", { acceptedAnswers: [] }), "deterministic");
});

test("free_sentence is always AI-evaluated", () => {
  assert.equal(evaluationForExercise("free_sentence", { acceptedAnswers: ["x"], deterministicSafe: true }), "ai");
});

test("correction is deterministic when it has an accepted-answer set, AI otherwise", () => {
  assert.equal(evaluationForExercise("correction", { acceptedAnswers: ["She doesn't like coffee."] }), "deterministic");
  assert.equal(evaluationForExercise("correction", { acceptedAnswers: [] }), "ai");
});

test("transformation needs the model to declare it safe AND supply a tight accepted set", () => {
  assert.equal(
    evaluationForExercise("transformation", { acceptedAnswers: ["I have lived here for three years."], deterministicSafe: true }),
    "deterministic"
  );
  // Declared safe, but no accepted answers at all — not safe to grade.
  assert.equal(evaluationForExercise("transformation", { acceptedAnswers: [], deterministicSafe: true }), "ai");
  // A tight set, but not declared safe — many transformations legitimately admit several forms.
  assert.equal(
    evaluationForExercise("transformation", { acceptedAnswers: ["a"], deterministicSafe: false }),
    "ai"
  );
  // A loose, sprawling set is not "tight" even if declared safe.
  assert.equal(
    evaluationForExercise("transformation", { acceptedAnswers: ["a", "b", "c", "d", "e"], deterministicSafe: true }),
    "ai"
  );
});

/* ---------------- answer checking ---------------- */

test("option answers tolerate case and surrounding whitespace but nothing else", () => {
  assert.equal(checkOptionAnswer("  Went  ", "went"), true);
  assert.equal(checkOptionAnswer("go", "went"), false);
  assert.equal(checkOptionAnswer("", "went"), false);
});

test("sentence answers tolerate case, punctuation and doubled spaces", () => {
  const r = checkSentenceAnswer("she  doesn't like coffee", ["She doesn't like coffee."]);
  assert.equal(r.correct, true);
});

test("unambiguous contractions are treated as the same answer", () => {
  const expanded = checkSentenceAnswer("She does not like coffee.", ["She doesn't like coffee."]);
  assert.equal(expanded.correct, true);
  const contracted = checkSentenceAnswer("She doesn't like coffee.", ["She does not like coffee."]);
  assert.equal(contracted.correct, true);
});

test("normalizeContractions never guesses an ambiguous expansion", () => {
  // "it's" could be "it is" or "it has" — left alone rather than guessed.
  assert.equal(normalizeContractions("it's fine"), "it's fine");
  assert.equal(normalizeContractions("I don't know"), "i do not know");
});

test("a different word is wrong, not near", () => {
  const r = checkSentenceAnswer("She loves coffee.", ["She doesn't like coffee."]);
  assert.equal(r.correct, false);
  assert.equal(r.near, false);
});

test("an answer that changes the meaning is rejected even when it is fluent English", () => {
  // Plausible-sounding but semantically wrong rewrite of a Present Perfect prompt.
  const r = checkSentenceAnswer(
    "I used to live here three years ago.",
    ["I have lived here for three years.", "I've lived here for three years."]
  );
  assert.equal(r.correct, false);
});

/* ---------------- reinforcement pool ---------------- */

function ex(over) {
  return { exercise_id: "k#0", pool: "base", active: 1, target_id: "past_simple", ...over };
}

test("findReserveExercise finds the un-activated reserve row for a target, deterministically", () => {
  const rows = [
    ex({ exercise_id: "k#3", pool: "reserve", active: 0, target_id: "past_simple" }),
    ex({ exercise_id: "k#1", pool: "reserve", active: 0, target_id: "past_simple" }),
    ex({ exercise_id: "k#2", pool: "reserve", active: 0, target_id: "articles" })
  ];
  const found = findReserveExercise(rows, "past_simple");
  assert.equal(found.exercise_id, "k#1");
});

test("an already-activated reserve row is not offered again", () => {
  const rows = [ex({ exercise_id: "k#1", pool: "reserve", active: 1, target_id: "past_simple" })];
  assert.equal(findReserveExercise(rows, "past_simple"), null);
});

test("reinforcementActivatedCount respects the per-target cap", () => {
  const rows = [ex({ exercise_id: "k#1", pool: "reserve", active: 1, target_id: "past_simple" })];
  assert.equal(reinforcementActivatedCount(rows, "past_simple"), REINFORCEMENT_CAP_PER_TARGET);
  assert.equal(reinforcementActivatedCount(rows, "articles"), 0);
});

/* ---------------- completion ---------------- */

test("completion requires every currently active exercise, and grows when reinforcement activates", () => {
  const exercises = [
    ex({ exercise_id: "k#0", active: 1 }),
    ex({ exercise_id: "k#1", active: 1 }),
    ex({ exercise_id: "k#2", pool: "reserve", active: 0 })
  ];
  const oneAttempt = [{ exercise_id: "k#0", target_id: "past_simple" }];
  let c = evaluateCompletion(exercises, oneAttempt);
  assert.equal(c.required, 2);
  assert.equal(c.attempted, 1);
  assert.equal(c.ready, false);

  const bothAttempted = oneAttempt.concat([{ exercise_id: "k#1", target_id: "past_simple" }]);
  c = evaluateCompletion(exercises, bothAttempted);
  assert.equal(c.ready, true);

  // Reinforcement activates: required grows, and the old attempt count is no longer enough.
  exercises[2].active = 1;
  c = evaluateCompletion(exercises, bothAttempted);
  assert.equal(c.required, 3);
  assert.equal(c.ready, false);
});

/* ---------------- summary ---------------- */

test("summariseSession sorts a target as strong only when nothing on it was wrong", () => {
  const targets = [PAST, ARTICLES];
  const exercises = [
    ex({ exercise_id: "k#0", target_id: "past_simple" }),
    ex({ exercise_id: "k#1", target_id: "past_simple" }),
    ex({ exercise_id: "k#2", target_id: "articles" })
  ];
  const attempts = [
    { exercise_id: "k#0", target_id: "past_simple", correct: 1 },
    { exercise_id: "k#1", target_id: "past_simple", correct: 0 },
    { exercise_id: "k#2", target_id: "articles", correct: 1 }
  ];
  const s = summariseSession(targets, exercises, attempts);
  assert.equal(s.itemsAttempted, 3);
  assert.equal(s.itemsCorrect, 2);
  assert.deepEqual(s.strong.map((t) => t.id), ["articles"]);
  assert.deepEqual(s.needsWork.map((t) => t.id), ["past_simple"]);
});

test("summariseSession ignores an attempt whose exercise is not (or is no longer) active", () => {
  const exercises = [ex({ exercise_id: "k#0", active: 0 })];
  const attempts = [{ exercise_id: "k#0", target_id: "past_simple", correct: 1 }];
  const s = summariseSession([PAST], exercises, attempts);
  assert.equal(s.itemsAttempted, 0);
  assert.equal(s.strong.length, 0);
});
