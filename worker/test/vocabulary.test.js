/**
 * Unit tests for the pure Vocabulary engine (src/vocabulary.js).
 *
 * No Worker, no database, no network — every function here takes its inputs as
 * arguments, which is what makes these assertions about behaviour rather than
 * about plumbing. The properties being pinned down:
 *
 *   - the review schedule reacts to evidence the way the product promises
 *   - a session is composed deterministically, so two devices agree
 *   - answer checking accepts what a teacher would accept and no more
 *   - building a session never needs a model
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  scheduleAfterAnswer,
  isStruggling,
  LAPSE_THRESHOLD,
  normalizeAnswer,
  answerKey,
  normalizeHebrew,
  checkTextAnswer,
  isNearMiss,
  blankOutTerm,
  pickDistractors,
  stableShuffle,
  chooseKind,
  availableKinds,
  buildExercise,
  composeSession,
  evaluateCompletion,
  summariseSession,
  sessionLimits,
  isPracticeMode,
  PRACTICE_KINDS,
  REVIEW_RULES
} from "../src/vocabulary.js";
import { MASTERY_INTERVAL_DAYS, DAY_MS } from "../src/planner.js";

const NOW = Date.parse("2026-03-10T09:00:00Z");

function word(over = {}) {
  return {
    id: over.id || "w1",
    english: "figure out",
    hebrew: "להבין",
    example: "It took me a while to figure out the new system.",
    mastery: "new",
    successes: 0,
    failures: 0,
    streak: 0,
    intervalDays: 0,
    lastPracticedAt: null,
    dueAt: null,
    source: "system",
    approval: "approved",
    ...over
  };
}

/* Ten distinct words, so multiple-choice always has real distractors. */
function library(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(word({
      id: "v" + i,
      english: "term-" + i,
      hebrew: "מילה-" + i,
      example: "You should term-" + i + " it before the meeting."
    }));
  }
  return out;
}

/* ---------------- spaced repetition ---------------- */

test("a first success moves the word up a rung and schedules it a day out", () => {
  const after = scheduleAfterAnswer(word(), { correct: true, now: NOW });
  assert.equal(after.mastery, "learning");
  assert.equal(after.successes, 1);
  assert.equal(after.streak, 1);
  assert.equal(after.intervalDays, MASTERY_INTERVAL_DAYS.learning);
  assert.equal(after.dueAt, NOW + MASTERY_INTERVAL_DAYS.learning * DAY_MS);
});

test("a wrong answer brings the word back much sooner than a right one", () => {
  const base = word({ mastery: "strong", successes: 4, failures: 0, streak: 4 });
  const right = scheduleAfterAnswer(base, { correct: true, now: NOW });
  const wrong = scheduleAfterAnswer(base, { correct: false, now: NOW });

  assert.equal(right.mastery, "mastered");
  assert.equal(wrong.mastery, "familiar");
  assert.ok(wrong.dueAt < right.dueAt, "a failure must schedule an earlier review");
  assert.equal(wrong.streak, 0);
});

test("repeated success lengthens the interval every step of the way", () => {
  let state = word();
  const intervals = [];
  for (let i = 0; i < 4; i++) {
    state = scheduleAfterAnswer(state, { correct: true, now: NOW });
    intervals.push(state.intervalDays);
  }
  assert.deepEqual(intervals, [1, 3, 7, 21]);
  assert.equal(state.mastery, "mastered");
});

test("repeated failure does not progress, and the word stays due immediately", () => {
  let state = word({ mastery: "learning", successes: 0, failures: 0 });
  for (let i = 0; i < 3; i++) {
    state = scheduleAfterAnswer(state, { correct: false, now: NOW });
  }
  assert.equal(state.mastery, "new");
  assert.equal(state.failures, 3);
  assert.equal(state.intervalDays, 0);
  assert.equal(state.dueAt, NOW, "a word being failed repeatedly comes back at once");
});

test("a struggling word comes back at half its rung's interval", () => {
  assert.equal(isStruggling({ successes: 1, failures: LAPSE_THRESHOLD }), true);
  assert.equal(isStruggling({ successes: 9, failures: LAPSE_THRESHOLD }), false, "more right than wrong is not struggling");
  assert.equal(isStruggling({ successes: 0, failures: LAPSE_THRESHOLD - 1 }), false, "one bad day is not struggling");

  // familiar normally spaces at 3 days; a word being failed gets 2.
  const struggling = scheduleAfterAnswer(
    word({ mastery: "strong", successes: 1, failures: 3 }),
    { correct: false, now: NOW }
  );
  assert.equal(struggling.mastery, "familiar");
  assert.equal(struggling.intervalDays, Math.ceil(MASTERY_INTERVAL_DAYS.familiar / 2));

  const healthy = scheduleAfterAnswer(
    word({ mastery: "strong", successes: 9, failures: 0 }),
    { correct: false, now: NOW }
  );
  assert.equal(healthy.intervalDays, MASTERY_INTERVAL_DAYS.familiar);
});

test("a mastered word still comes back, it is never retired", () => {
  const after = scheduleAfterAnswer(
    word({ mastery: "mastered", successes: 12, failures: 0 }),
    { correct: true, now: NOW }
  );
  assert.equal(after.mastery, "mastered");
  assert.ok(after.intervalDays > 0 && Number.isFinite(after.dueAt));
  assert.equal(after.intervalDays, MASTERY_INTERVAL_DAYS.mastered);
});

test("mastery can regress all the way down when performance collapses", () => {
  let state = word({ mastery: "mastered", successes: 10, failures: 0 });
  for (let i = 0; i < 4; i++) {
    state = scheduleAfterAnswer(state, { correct: false, now: NOW });
  }
  assert.equal(state.mastery, "new");
  assert.equal(state.dueAt, NOW);
});

test("scheduling is deterministic: same state and time, same result", () => {
  const a = scheduleAfterAnswer(word({ mastery: "familiar", successes: 3, failures: 1 }), { correct: true, now: NOW });
  const b = scheduleAfterAnswer(word({ mastery: "familiar", successes: 3, failures: 1 }), { correct: true, now: NOW });
  assert.deepEqual(a, b);
});

test("the published review rules describe what the code actually does", () => {
  assert.equal(REVIEW_RULES.strugglingAfterFailures, LAPSE_THRESHOLD);
  assert.deepEqual(REVIEW_RULES.intervalDays, MASTERY_INTERVAL_DAYS);
  assert.match(REVIEW_RULES.decidedBy, /no AI/i);
});

/* ---------------- answer checking ---------------- */

test("answers are compared past case, punctuation and spacing", () => {
  assert.equal(normalizeAnswer("  Figure   OUT! "), "figure out");
  assert.equal(checkTextAnswer("Figure out.", ["figure out"]).correct, true);
  assert.equal(checkTextAnswer("figure  out", ["figure out"]).correct, true);
});

test("a leading article or 'to' does not make an answer wrong", () => {
  assert.equal(answerKey("to figure out"), "figure out");
  assert.equal(checkTextAnswer("to figure out", ["figure out"]).correct, true);
  assert.equal(checkTextAnswer("the deadline", ["deadline"]).correct, true);
});

test("a different word is wrong, not near", () => {
  const r = checkTextAnswer("understand", ["figure out"]);
  assert.equal(r.correct, false);
  assert.equal(r.near, false);
});

test("a single typo in a long word is reported as near, but still not correct", () => {
  const r = checkTextAnswer("recieve", ["receive"]);
  assert.equal(r.correct, false);
  assert.equal(r.near, true, "the learner deserves 'check the spelling', not a flat wrong");

  // Short words must not be forgiven: cat and cut are different words.
  assert.equal(isNearMiss("cat", "cut"), false);
  assert.equal(isNearMiss("receive", "recieve"), true);
  assert.equal(isNearMiss("figure", "figures"), true);
});

test("an empty answer is never correct", () => {
  assert.equal(checkTextAnswer("   ", ["figure out"]).correct, false);
});

test("Hebrew answers ignore nikud and punctuation", () => {
  assert.equal(normalizeHebrew("לְהָבִין,"), "להבין");
  assert.equal(checkTextAnswer("לְהָבִין", ["להבין"], { hebrew: true }).correct, true);
});

/* ---------------- blanking ---------------- */

test("the term is removed from its own example, inflection and all", () => {
  const b = blankOutTerm("It took me a while to figure out the new system.", "figure out");
  assert.equal(b.blanked, "It took me a while to _____ the new system.");

  const inflected = blankOutTerm("She figured out the problem alone.", "figure out");
  assert.equal(inflected.blanked, "She _____ the problem alone.");
  assert.equal(inflected.matchedForm, "figured out");
});

test("a term that is not in the sentence yields no blank rather than a broken one", () => {
  assert.equal(blankOutTerm("A sentence about something else.", "figure out"), null);
  assert.equal(blankOutTerm("", "figure out"), null);
  assert.equal(blankOutTerm("Some sentence.", ""), null);
});

test("blanking matches whole words only", () => {
  assert.equal(blankOutTerm("He is a catalyst for change.", "cat"), null);
});

/* ---------------- distractors and shuffling ---------------- */

test("distractors never include the right answer and never repeat", () => {
  const pool = library(8);
  const options = pickDistractors(pool, ["מילה-3"], 3, "seed", "hebrew");
  assert.equal(options.length, 3);
  assert.equal(options.indexOf("מילה-3"), -1);
  assert.equal(new Set(options).size, 3);
});

test("distractors and option order are the same on every device", () => {
  const pool = library(8);
  const a = pickDistractors(pool, ["מילה-1"], 3, "2026-03-10", "hebrew");
  const b = pickDistractors(pool, ["מילה-1"], 3, "2026-03-10", "hebrew");
  assert.deepEqual(a, b);
  assert.deepEqual(stableShuffle(["a", "b", "c", "d"], "k"), stableShuffle(["a", "b", "c", "d"], "k"));
});

/* ---------------- exercise choice ---------------- */

test("Smart Mix teaches a new word before demanding it back", () => {
  const all = { en_he: true, he_en: true, fill_blank: true, meaning_context: true, write_sentence: true };
  assert.equal(chooseKind(word({ mastery: "new" }), { available: all }), "en_he");
  assert.equal(chooseKind(word({ mastery: "learning" }), { available: all }), "he_en");
  assert.equal(chooseKind(word({ mastery: "familiar" }), { available: all }), "fill_blank");
  assert.equal(chooseKind(word({ mastery: "strong" }), { available: all }), "meaning_context");
  assert.equal(chooseKind(word({ mastery: "mastered" }), { available: all }), "write_sentence");
});

test("a word the learner keeps failing is pulled back to recognition", () => {
  const all = { en_he: true, he_en: true, fill_blank: true, meaning_context: true, write_sentence: true };
  const stuck = word({ mastery: "mastered", successes: 1, failures: 4 });
  assert.equal(chooseKind(stuck, { available: all }), "en_he");
});

test("an unavailable kind is skipped, never shown broken", () => {
  const noContext = { en_he: true, he_en: true, fill_blank: false, meaning_context: false, write_sentence: true };
  assert.equal(chooseKind(word({ mastery: "familiar" }), { available: noContext }), "he_en");
  // Hebrew->English needs nothing but the word, so there is always a fallback.
  assert.equal(chooseKind(word({ mastery: "familiar" }), { available: {} }), "he_en");
});

test("availability reflects what the word actually has", () => {
  const withEverything = availableKinds(word(), { hebrewPoolSize: 9, englishPoolSize: 9, contextByItem: { w1: {} } });
  assert.deepEqual(withEverything, {
    en_he: true, he_en: true, fill_blank: true, meaning_context: true, write_sentence: true
  });

  const bare = availableKinds(word({ example: "" }), { hebrewPoolSize: 1, englishPoolSize: 1, contextByItem: {} });
  assert.equal(bare.fill_blank, false, "no example sentence, no fill-in-the-blank");
  assert.equal(bare.meaning_context, false, "no AI content, no meaning-in-context");
  assert.equal(bare.en_he, false, "two words in the library cannot make plausible options");
  assert.equal(bare.he_en, true);
});

/* ---------------- building one exercise ---------------- */

test("English to Hebrew is multiple choice built from the learner's own words", () => {
  const pool = library(6).concat([word()]);
  const ex = buildExercise(word(), "en_he", { seed: "s", pool: pool, contextByItem: {} });
  assert.equal(ex.contentFrom, "local");
  assert.equal(ex.evaluation, "deterministic");
  assert.equal(ex.prompt.format, "choice");
  assert.equal(ex.prompt.question, "figure out");
  assert.equal(ex.prompt.options.length, 4);
  assert.ok(ex.prompt.options.includes("להבין"));
  assert.equal(ex.answer.correctOption, "להבין");
});

test("the correct answer is never part of the prompt half of a text exercise", () => {
  const ex = buildExercise(word(), "he_en", { seed: "s", pool: [], contextByItem: {} });
  assert.equal(JSON.stringify(ex.prompt).includes("figure out"), false);
  assert.deepEqual(ex.answer.accepted, ["figure out"]);
});

test("fill in the blank accepts both the dictionary form and the sentence's form", () => {
  const item = word({ example: "She figured out the problem alone." });
  const ex = buildExercise(item, "fill_blank", { seed: "s", pool: [], contextByItem: {} });
  assert.match(ex.prompt.question, /_____/);
  assert.deepEqual(ex.answer.accepted, ["figure out", "figured out"]);
  assert.equal(ex.contentFrom, "local");
});

test("meaning in context is the only kind whose content comes from the model", () => {
  const ctx = {
    seed: "s",
    pool: [],
    contextByItem: {
      w1: { sentence: "I could not figure out why it failed.", correctMeaning: "להבין", wrongMeanings: ["לשכוח", "למדוד", "לבטל"] }
    }
  };
  const ex = buildExercise(word(), "meaning_context", ctx);
  assert.equal(ex.contentFrom, "gemini");
  assert.equal(ex.evaluation, "deterministic", "the content needs AI; marking it does not");
  assert.equal(ex.prompt.options.length, 4);
  assert.equal(ex.answer.correctOption, "להבין");
});

test("meaning in context is refused rather than half-built when content is missing", () => {
  assert.equal(buildExercise(word(), "meaning_context", { seed: "s", pool: [], contextByItem: {} }), null);
  assert.equal(
    buildExercise(word(), "meaning_context", {
      seed: "s", pool: [],
      contextByItem: { w1: { sentence: "x", correctMeaning: "y", wrongMeanings: ["z"] } }
    }),
    null,
    "two options is not a multiple-choice question"
  );
});

test("write your own sentence needs no generated content, only AI marking", () => {
  const ex = buildExercise(word(), "write_sentence", { seed: "s", pool: [], contextByItem: {} });
  assert.equal(ex.contentFrom, "local");
  assert.equal(ex.evaluation, "ai");
  assert.equal(PRACTICE_KINDS.write_sentence.needsAi, false);
  assert.equal(PRACTICE_KINDS.write_sentence.aiEvaluated, true);
});

/* ---------------- composing a session ---------------- */

test("Smart Mix mixes exercise types across a realistic session", () => {
  const pool = library(10);
  const composed = composeSession({
    mode: "standard",
    practiceMode: "smart_mix",
    sessionKey: "2026-03-10",
    newItems: [word({ id: "n1", mastery: "new" }), word({ id: "n2", mastery: "new" })],
    reviewItems: [
      word({ id: "r1", mastery: "learning" }),
      word({ id: "r2", mastery: "familiar" }),
      word({ id: "r3", mastery: "mastered", successes: 9 })
    ],
    pool: pool,
    contextByItem: {}
  });

  const kinds = new Set(composed.exercises.map((e) => e.kind));
  assert.ok(kinds.size >= 3, "Smart Mix must produce more than one kind of question: " + [...kinds]);
  assert.equal(composed.requiredExercises, composed.exercises.length);
  assert.deepEqual(composed.introducedItemIds, ["n1", "n2"]);
});

test("a focused mode produces only that kind of exercise", () => {
  const pool = library(10);
  for (const mode of ["en_he", "he_en", "fill_blank", "write_sentence"]) {
    const composed = composeSession({
      mode: "standard",
      practiceMode: mode,
      sessionKey: "2026-03-10:" + mode,
      newItems: [],
      reviewItems: [word({ id: "r1", mastery: "familiar" }), word({ id: "r2", mastery: "strong" })],
      pool: pool,
      contextByItem: {}
    });
    assert.ok(composed.exercises.length > 0, mode + " produced nothing");
    for (const e of composed.exercises) assert.equal(e.kind, mode);
  }
});

test("a focused mode skips words that cannot support it rather than downgrading them", () => {
  const composed = composeSession({
    mode: "standard",
    practiceMode: "fill_blank",
    sessionKey: "k",
    newItems: [],
    reviewItems: [word({ id: "ok" }), word({ id: "noexample", example: "" })],
    pool: library(6),
    contextByItem: {}
  });
  assert.deepEqual(composed.exercises.map((e) => e.itemId), ["ok"]);
});

test("building a session is deterministic, so two devices see the same questions", () => {
  const input = {
    mode: "standard",
    practiceMode: "smart_mix",
    sessionKey: "2026-03-10",
    newItems: [word({ id: "n1" })],
    reviewItems: [word({ id: "r1", mastery: "familiar" }), word({ id: "r2", mastery: "learning" })],
    pool: library(10),
    contextByItem: {}
  };
  assert.deepEqual(composeSession(input), composeSession(input));
});

test("the session never grows past the session length's ceiling", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(word({ id: "m" + i, mastery: "learning" }));
  for (const mode of ["quick", "standard", "full"]) {
    const composed = composeSession({
      mode: mode,
      practiceMode: "smart_mix",
      sessionKey: "k-" + mode,
      newItems: [],
      reviewItems: many,
      pool: many,
      contextByItem: {}
    });
    assert.ok(
      composed.exercises.length <= sessionLimits(mode).maxExercises,
      mode + " produced " + composed.exercises.length
    );
  }
});

test("the depth pass never asks the same word the same question twice", () => {
  const composed = composeSession({
    mode: "full",
    practiceMode: "smart_mix",
    sessionKey: "k",
    newItems: [],
    reviewItems: [word({ id: "r1", mastery: "mastered", successes: 9 })],
    pool: library(10),
    contextByItem: {}
  });
  const forItem = composed.exercises.filter((e) => e.itemId === "r1").map((e) => e.kind);
  assert.equal(new Set(forItem).size, forItem.length, "duplicate kinds for one word: " + forItem);
});

test("practice mode names are validated", () => {
  assert.equal(isPracticeMode("smart_mix"), true);
  assert.equal(isPracticeMode("he_en"), true);
  assert.equal(isPracticeMode("telepathy"), false);
  assert.equal(isPracticeMode(undefined), false);
});

/* ---------------- completion ---------------- */

test("completion needs every question attempted and every new word met", () => {
  const session = { requiredExercises: 3, newItemIds: ["n1"], introducedItemIds: ["n1"] };

  const partial = evaluateCompletion(session, [
    { exercise_id: "k#0", item_id: "n1" },
    { exercise_id: "k#1", item_id: "r1" }
  ]);
  assert.equal(partial.ready, false);
  assert.equal(partial.attempted, 2);
  assert.equal(partial.required, 3);

  const done = evaluateCompletion(session, [
    { exercise_id: "k#0", item_id: "n1" },
    { exercise_id: "k#1", item_id: "r1" },
    { exercise_id: "k#2", item_id: "r2" }
  ]);
  assert.equal(done.ready, true);
});

test("skipping a new word blocks completion even when the count is met", () => {
  const session = { requiredExercises: 2, newItemIds: ["n1"], introducedItemIds: ["n1"] };
  const result = evaluateCompletion(session, [
    { exercise_id: "k#1", item_id: "r1" },
    { exercise_id: "k#2", item_id: "r2" }
  ]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingIntroductions, ["n1"]);
});

test("the completion rule is stated in both languages for the UI to show", () => {
  const r = evaluateCompletion({ requiredExercises: 1, newItemIds: [] }, []);
  assert.ok(r.rule.length > 0);
  assert.ok(r.ruleHe.length > 0);
});

/* ---------------- summary ---------------- */

test("the summary names words rather than reporting one percentage", () => {
  const items = {
    n1: { id: "n1", english: "figure out", hebrew: "להבין" },
    r1: { id: "r1", english: "put off", hebrew: "לדחות" },
    r2: { id: "r2", english: "call off", hebrew: "לבטל" }
  };
  const summary = summariseSession(
    { newItemIds: ["n1"] },
    [
      { exercise_id: "a", item_id: "n1", correct: 1 },
      { exercise_id: "b", item_id: "r1", correct: 1 },
      { exercise_id: "c", item_id: "r2", correct: 0 }
    ],
    items
  );
  assert.equal(summary.itemsAttempted, 3);
  assert.equal(summary.itemsCorrect, 2);
  assert.equal(summary.accuracy, 67);
  assert.deepEqual(summary.introduced.map((v) => v.english), ["figure out"]);
  assert.deepEqual(summary.improved.map((v) => v.english), ["put off"]);
  assert.deepEqual(summary.needsReview.map((v) => v.english), ["call off"]);
});
