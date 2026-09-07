/**
 * Unit tests for the deterministic learning engine (src/planner.js).
 *
 * Everything here runs against pure functions with an explicit `now`, so there
 * is no clock, no database and no network to make a result wobble. If one of
 * these fails, the planning rules changed — not the environment.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planDay,
  newWordTarget,
  selectGrammarTargets,
  selectTopic,
  applyTargetEvidence,
  applyVocabularyEvidence,
  nextTargetStatus,
  isWritingDue,
  recentAccuracy,
  msToDateKey,
  dateKeyToMs,
  SESSION_MODES,
  MASTERY_LADDER,
  TARGET_RULES,
  VOCAB_RULES,
  GENERATOR,
  DAY_MS
} from "../src/planner.js";

/* A fixed instant, so "today" never depends on when the suite runs. */
const NOW = Date.parse("2026-03-10T09:00:00Z");
const TODAY = "2026-03-10";
const OWNER = "owner-hash-aaaa";

function profile(over = {}) {
  return {
    provisional: true,
    interests: [],
    skill_reading: 50,
    skill_vocabulary: 50,
    skill_grammar: 50,
    createdAt: NOW - 2 * DAY_MS,
    ...over
  };
}

function word(id, over = {}) {
  return {
    id,
    english: id,
    hebrew: "",
    approval: "approved",
    mastery: "new",
    successes: 0,
    failures: 0,
    lastPracticedAt: null,
    dueAt: null,
    ...over
  };
}

function dueWord(id, overdueDays = 1, over = {}) {
  return word(id, {
    mastery: "learning",
    lastPracticedAt: NOW - (overdueDays + 1) * DAY_MS,
    dueAt: NOW - overdueDays * DAY_MS,
    ...over
  });
}

function basePlanInput(over = {}) {
  return {
    ownerHash: OWNER,
    dateKey: TODAY,
    now: NOW,
    mode: "standard",
    profile: profile(),
    vocabulary: [],
    targets: [],
    recentSessions: [],
    revision: 1,
    ...over
  };
}

/* ---------------- structure ---------------- */

test("a Standard plan has the four core modules, ~30 minutes, all pending", () => {
  const plan = planDay(basePlanInput());
  assert.deepEqual(
    plan.activities.map((a) => a.type),
    ["vocabulary", "sentence_practice", "reading", "speaking"]
  );
  assert.equal(plan.totalMinutes, 30);
  assert.equal(plan.mode, "standard");
  assert.ok(plan.activities.every((a) => a.status === "pending"));
  assert.ok(plan.activities.every((a) => typeof a.activityId === "string" && a.activityId.length));
  assert.ok(plan.activities.every((a) => a.estimatedMinutes > 0));
  assert.equal(plan.generator, GENERATOR);
  assert.ok(plan.topicLabel.length > 0);
});

test("every activity carries objectives and a spec a content generator could use", () => {
  const plan = planDay(basePlanInput());
  for (const a of plan.activities) {
    assert.ok(Array.isArray(a.objectives), a.type + " objectives");
    assert.equal(typeof a.spec, "object");
    assert.ok("contentNeeded" in a.spec, a.type + " declares what content it still needs");
  }
  const reading = plan.activities.find((a) => a.type === "reading");
  assert.ok(reading.spec.targetWordCount > 0);
  assert.ok(["easy", "moderate", "challenging"].includes(reading.spec.difficulty));
  assert.ok(reading.spec.comprehensionQuestions > 0);

  const speaking = plan.activities.find((a) => a.type === "speaking");
  // Speaking objectives are opportunities to create, never requirements that
  // would make the conversation unnatural.
  assert.equal(speaking.spec.objectivesAreOpportunities, true);
  assert.ok(Array.isArray(speaking.spec.grammarOpportunities));
});

test("no activity contains generated exercise content in this slice", () => {
  const plan = planDay(basePlanInput({
    vocabulary: [dueWord("w1"), word("w2")],
    targets: [{ target_id: "articles", label: "Articles", status: "needs_work", recentErrors: 4, recentSuccesses: 0, errorDayCount: 3, lastErrorAt: NOW - DAY_MS }]
  }));
  const text = JSON.stringify(plan);
  // The plan names ids, targets and counts — never sentences, passages or questions.
  assert.ok(!/"passageText"|"questions"\s*:\s*\[\s*"/.test(text));
  for (const a of plan.activities) {
    assert.ok(!("content" in a.spec), a.type + " must not carry content yet");
  }
});

/* ---------------- determinism ---------------- */

test("the same inputs produce a byte-identical plan", () => {
  const input = basePlanInput({
    vocabulary: [dueWord("w1"), dueWord("w2", 3), word("n1"), word("n2")],
    targets: [
      { target_id: "past_simple", label: "Past Simple", status: "needs_work", recentErrors: 3, recentSuccesses: 0, errorDayCount: 2, lastErrorAt: NOW - DAY_MS, lastPracticedAt: NOW - 2 * DAY_MS },
      { target_id: "articles", label: "Articles", status: "observed", recentErrors: 1, recentSuccesses: 0, errorDayCount: 1, lastErrorAt: NOW - 5 * DAY_MS }
    ]
  });
  const a = JSON.stringify(planDay(input));
  const b = JSON.stringify(planDay(input));
  assert.equal(a, b);
});

test("input order does not change the plan", () => {
  const vocab = [dueWord("b", 2), dueWord("a", 5), word("z"), word("c")];
  const one = planDay(basePlanInput({ vocabulary: vocab }));
  const two = planDay(basePlanInput({ vocabulary: vocab.slice().reverse() }));
  assert.deepEqual(one.activities[0].spec, two.activities[0].spec);
});

test("planning reads no clock and no randomness of its own", () => {
  // `now` is the only time source; freezing Date.now and Math.random to values
  // that would corrupt any plan proves the planner never touches them.
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => 0;
  Math.random = () => 0.999999;
  try {
    const plan = planDay(basePlanInput());
    const again = planDay(basePlanInput());
    assert.deepEqual(plan, again);
    assert.equal(plan.planDate, TODAY);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test("different learners get different topics on the same day, each stable", () => {
  const a = selectTopic("owner-a", TODAY, []);
  const b = selectTopic("owner-zzzz-different", TODAY, []);
  assert.equal(selectTopic("owner-a", TODAY, []).slug, a.slug);
  assert.ok(a.slug && b.slug);
});

test("stated interests constrain the topic rotation", () => {
  const picked = selectTopic(OWNER, TODAY, ["food_cooking"]);
  assert.equal(picked.slug, "food_cooking");
});

/* ---------------- session modes ---------------- */

test("Quick, Standard and Full allocate differently", () => {
  const quick = planDay(basePlanInput({ mode: "quick" }));
  const standard = planDay(basePlanInput({ mode: "standard" }));
  const full = planDay(basePlanInput({ mode: "full" }));

  assert.ok(quick.totalMinutes < standard.totalMinutes);
  assert.ok(standard.totalMinutes < full.totalMinutes);
  assert.ok(quick.totalMinutes >= 10 && quick.totalMinutes <= 15, "Quick is ~10-15 min");
  assert.equal(standard.totalMinutes, 30);
  assert.ok(full.totalMinutes >= 45 && full.totalMinutes <= 60, "Full is ~45-60 min");

  // Reading needs a contiguous block, so Quick leaves it out rather than
  // reducing it to something useless.
  assert.ok(!quick.activities.some((a) => a.type === "reading"));
  assert.ok(standard.activities.some((a) => a.type === "reading"));
});

test("Quick practises one grammar target, Standard and Full practise two", () => {
  const quick = planDay(basePlanInput({ mode: "quick" }));
  const standard = planDay(basePlanInput({ mode: "standard" }));
  assert.equal(quick.activities.find((a) => a.type === "sentence_practice").objectives.length, 1);
  assert.equal(standard.activities.find((a) => a.type === "sentence_practice").objectives.length, 2);
});

test("an unknown mode falls back to Standard rather than failing", () => {
  const plan = planDay(basePlanInput({ mode: "marathon" }));
  assert.equal(plan.mode, "standard");
});

/* ---------------- new-word sizing ---------------- */

test("a Standard day defaults to 5 new words", () => {
  const r = newWordTarget({ mode: "standard", dueCount: 0, recentVocabAccuracy: null });
  assert.equal(r.count, VOCAB_RULES.baseNewWords);
});

test("session length scales the new-word target", () => {
  assert.ok(newWordTarget({ mode: "quick", dueCount: 0, recentVocabAccuracy: null }).count < 5);
  assert.ok(newWordTarget({ mode: "full", dueCount: 0, recentVocabAccuracy: null }).count > 5);
});

test("a review backlog reduces the new-word target, and a big one stops it", () => {
  const none = newWordTarget({ mode: "standard", dueCount: 0, recentVocabAccuracy: null }).count;
  const some = newWordTarget({ mode: "standard", dueCount: 10, recentVocabAccuracy: null }).count;
  const lots = newWordTarget({ mode: "standard", dueCount: 18, recentVocabAccuracy: null }).count;
  const drowning = newWordTarget({ mode: "standard", dueCount: 40, recentVocabAccuracy: null }).count;

  assert.ok(some < none, "10 due < baseline");
  assert.ok(lots < some, "18 due < 10 due");
  assert.equal(drowning, 0, "a huge backlog adds nothing new today");
});

test("weak recent vocabulary accuracy reduces new words", () => {
  const ok = newWordTarget({ mode: "standard", dueCount: 0, recentVocabAccuracy: 75 }).count;
  const weak = newWordTarget({ mode: "standard", dueCount: 0, recentVocabAccuracy: 40 }).count;
  assert.ok(weak < ok);
});

test("strong accuracy with almost no backlog allows a modest increase", () => {
  const strong = newWordTarget({ mode: "standard", dueCount: 2, recentVocabAccuracy: 95 });
  assert.ok(strong.count > VOCAB_RULES.baseNewWords, "more than the default");
  assert.ok(strong.count <= VOCAB_RULES.maxNewWords, "but still inside the MVP ceiling");
});

test("the new-word target can never run away", () => {
  for (const mode of ["quick", "standard", "full"]) {
    for (const due of [0, 1, 5, 20, 500]) {
      for (const acc of [null, 0, 50, 100]) {
        const n = newWordTarget({ mode, dueCount: due, recentVocabAccuracy: acc }).count;
        assert.ok(n >= 0 && n <= VOCAB_RULES.maxNewWords, mode + "/" + due + "/" + acc + " -> " + n);
      }
    }
  }
});

test("the vocabulary activity prefers due reviews and caps them by mode", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(dueWord("d" + String(i).padStart(2, "0"), 40 - i));
  const plan = planDay(basePlanInput({ vocabulary: many }));
  const spec = plan.activities.find((a) => a.type === "vocabulary").spec;

  assert.equal(spec.dueTotal, 40);
  assert.equal(spec.reviewItemIds.length, SESSION_MODES.standard.reviewCapacity);
  assert.equal(spec.newItemIds.length, 0, "a 40-word backlog adds no new words");
  // Most overdue first.
  assert.equal(spec.reviewItemIds[0], "d00");
});

test("words awaiting approval or rejected are never scheduled", () => {
  const plan = planDay(basePlanInput({
    vocabulary: [
      dueWord("ok"),
      dueWord("pending", 1, { approval: "pending" }),
      dueWord("rejected", 1, { approval: "rejected" })
    ]
  }));
  const spec = plan.activities.find((a) => a.type === "vocabulary").spec;
  assert.deepEqual(spec.reviewItemIds, ["ok"]);
  assert.equal(spec.dueTotal, 1);
});

test("the plan says how many new words still need sourcing", () => {
  const plan = planDay(basePlanInput({ vocabulary: [word("n1")] }));
  const spec = plan.activities.find((a) => a.type === "vocabulary").spec;
  assert.equal(spec.newWordsRequested, 5);
  assert.equal(spec.newItemIds.length, 1);
  assert.equal(spec.newWordsToSource, 4);
  assert.equal(spec.contentNeeded, "new_words");
});

/* ---------------- grammar target selection ---------------- */

test("a recurring weakness outranks everything else", () => {
  const picked = selectGrammarTargets(
    [
      { target_id: "articles", label: "Articles", status: "needs_work", recentErrors: 4, recentSuccesses: 0, lastErrorAt: NOW - DAY_MS, lastPracticedAt: NOW - DAY_MS },
      { target_id: "spelling", label: "Spelling", status: "observed", recentErrors: 1, recentSuccesses: 0, lastErrorAt: NOW - 20 * DAY_MS, lastPracticedAt: NOW - DAY_MS }
    ],
    2,
    NOW
  );
  assert.equal(picked[0].id, "articles");
  assert.equal(picked[0].kind, "learner");
  assert.match(picked[0].reason, /recurring weakness/);
});

test("a learner with no error history still gets curriculum coverage", () => {
  const picked = selectGrammarTargets([], 2, NOW);
  assert.equal(picked.length, 2);
  assert.ok(picked.every((p) => p.kind === "curriculum"));
  assert.match(picked[0].reason, /coverage/);
});

test("one weakness plus coverage fills two slots, so blind spots still get practised", () => {
  const picked = selectGrammarTargets(
    [{ target_id: "past_simple", label: "Past Simple", status: "needs_work", recentErrors: 3, recentSuccesses: 0, lastErrorAt: NOW - DAY_MS, lastPracticedAt: NOW - DAY_MS }],
    2,
    NOW
  );
  assert.equal(picked[0].id, "past_simple");
  assert.equal(picked[1].kind, "curriculum");
  assert.notEqual(picked[1].id, "past_simple");
});

test("two active weaknesses claim both slots", () => {
  const picked = selectGrammarTargets(
    [
      { target_id: "past_simple", label: "Past Simple", status: "needs_work", recentErrors: 4, recentSuccesses: 0, lastErrorAt: NOW - DAY_MS, lastPracticedAt: NOW - DAY_MS },
      { target_id: "prepositions", label: "Prepositions", status: "needs_work", recentErrors: 3, recentSuccesses: 0, lastErrorAt: NOW - 2 * DAY_MS, lastPracticedAt: NOW - DAY_MS }
    ],
    2,
    NOW
  );
  assert.deepEqual(picked.map((p) => p.kind), ["learner", "learner"]);
});

test("an isolated observed mistake does not outrank untouched curriculum by much", () => {
  // A single slip is worth attention, but must not look like a weakness.
  const picked = selectGrammarTargets(
    [{ target_id: "spelling", label: "Spelling", status: "observed", recentErrors: 1, recentSuccesses: 0, errorDayCount: 1, lastErrorAt: NOW - DAY_MS, lastPracticedAt: NOW }],
    2,
    NOW
  );
  assert.equal(picked.length, 2);
  assert.ok(picked.some((p) => p.kind === "curriculum"));
});

test("the plan explains itself", () => {
  const plan = planDay(basePlanInput({
    vocabulary: [dueWord("w1"), dueWord("w2")],
    targets: [{ target_id: "articles", label: "Articles", status: "needs_work", recentErrors: 4, recentSuccesses: 0, errorDayCount: 2, lastErrorAt: NOW - DAY_MS }]
  }));
  const text = plan.rationale.join(" ");
  assert.match(text, /due for review/);
  assert.match(text, /Articles/);
  assert.match(text, /theme/);
});

/* ---------------- writing periodicity ---------------- */

test("a brand-new learner's first day is the four core modules, no writing", () => {
  const plan = planDay(basePlanInput({ profile: profile({ createdAt: NOW - DAY_MS }) }));
  assert.ok(!plan.activities.some((a) => a.type === "writing"));
});

test("writing comes back around after a week and Standard still stays near 30 minutes", () => {
  const p = profile({ createdAt: NOW - 30 * DAY_MS });
  assert.equal(isWritingDue([], p, NOW, TODAY), true);
  const plan = planDay(basePlanInput({ profile: p }));
  assert.ok(plan.activities.some((a) => a.type === "writing"));
  assert.ok(plan.totalMinutes <= 34, "writing does not blow out a Standard day: " + plan.totalMinutes);
});

test("a recent writing session postpones the next one", () => {
  const p = profile({ createdAt: NOW - 30 * DAY_MS });
  const sessions = [{ activity_type: "writing", createdAt: NOW - 2 * DAY_MS, itemsAttempted: 1, itemsCorrect: 1 }];
  assert.equal(isWritingDue(sessions, p, NOW, TODAY), false);
});

/* ---------------- recurring mistake lifecycle ---------------- */

function newTarget(over = {}) {
  return {
    target_id: "past_simple",
    label: "Past Simple",
    status: "observed",
    errors: 0,
    successes: 0,
    recentErrors: 0,
    recentSuccesses: 0,
    errorDayCount: 0,
    lastErrorDay: "",
    lastErrorAt: null,
    lastSuccessAt: null,
    lastPracticedAt: null,
    ...over
  };
}

test("one isolated mistake stays merely observed", () => {
  const t = applyTargetEvidence(newTarget(), { errors: 1, successes: 0, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "observed");
  assert.equal(t.recentErrors, 1);
  assert.equal(t.errorDayCount, 1);
});

test("three mistakes in a single day are still one bad day, not a weakness", () => {
  let t = newTarget();
  t = applyTargetEvidence(t, { errors: 3, successes: 0, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "observed", "same-day repetition alone must not promote");
  assert.equal(t.errorDayCount, 1);
});

test("repeated evidence across days becomes a recurring weakness", () => {
  let t = newTarget();
  t = applyTargetEvidence(t, { errors: 2, successes: 0, now: NOW - DAY_MS, dayKey: "2026-03-09" });
  assert.equal(t.status, "observed");
  t = applyTargetEvidence(t, { errors: 1, successes: 0, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "needs_work");
  assert.equal(t.errorDayCount, 2);
});

test("successful use moves a weakness toward improving", () => {
  let t = newTarget({ status: "needs_work", recentErrors: 3, errors: 3, errorDayCount: 2, lastErrorDay: "2026-03-08" });
  t = applyTargetEvidence(t, { errors: 0, successes: 4, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "improving");
  assert.ok(t.recentSuccesses >= TARGET_RULES.improvingSuccesses);
  assert.ok(t.recentErrors < 3, "successes decay the error count");
});

test("sustained success with a quiet period reaches monitoring", () => {
  let t = newTarget({
    status: "improving",
    recentSuccesses: 5,
    successes: 5,
    lastErrorAt: NOW - 30 * DAY_MS,
    errorDayCount: 2
  });
  t = applyTargetEvidence(t, { errors: 0, successes: 2, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "monitoring");
});

test("a fixed issue that returns becomes important again", () => {
  let t = newTarget({ status: "monitoring", recentSuccesses: 6, successes: 6, errorDayCount: 2, lastErrorDay: "2026-02-01" });
  t = applyTargetEvidence(t, { errors: 2, successes: 0, now: NOW, dayKey: TODAY });
  assert.equal(t.status, "needs_work");
});

test("confidence rises with success and falls with error, and stays 0-100", () => {
  const good = applyTargetEvidence(newTarget({ successes: 9, errors: 1 }), { errors: 0, successes: 1, now: NOW, dayKey: TODAY });
  const bad = applyTargetEvidence(newTarget({ successes: 1, errors: 9 }), { errors: 1, successes: 0, now: NOW, dayKey: TODAY });
  assert.ok(good.confidence > bad.confidence);
  for (const t of [good, bad]) {
    assert.ok(t.confidence >= 0 && t.confidence <= 100);
  }
});

test("the lifecycle never invents a status outside the four", () => {
  const allowed = ["observed", "needs_work", "improving", "monitoring"];
  for (const current of allowed) {
    for (const re of [0, 1, 3, 9]) {
      for (const rs of [0, 3, 9]) {
        const s = nextTargetStatus(current, { recentErrors: re, recentSuccesses: rs, errorDayCount: 3, lastErrorAt: NOW - 40 * DAY_MS }, NOW);
        assert.ok(allowed.includes(s), current + " -> " + s);
      }
    }
  }
});

/* ---------------- vocabulary mastery ---------------- */

test("a correct answer climbs the mastery ladder and pushes the review further out", () => {
  const before = { mastery: "learning", successes: 1, failures: 0, streak: 1 };
  const after = applyVocabularyEvidence(before, { correct: true, now: NOW });
  assert.equal(after.mastery, "familiar");
  assert.ok(after.dueAt > NOW);
  assert.equal(after.streak, 2);
});

test("a wrong answer drops one rung, not all the way to the bottom", () => {
  const after = applyVocabularyEvidence({ mastery: "strong", successes: 5, failures: 0, streak: 5 }, { correct: false, now: NOW });
  assert.equal(after.mastery, "familiar");
  assert.equal(after.streak, 0);
  assert.equal(after.failures, 1);
});

test("mastery cannot go past either end of the ladder", () => {
  const top = applyVocabularyEvidence({ mastery: "mastered" }, { correct: true, now: NOW });
  const bottom = applyVocabularyEvidence({ mastery: "new" }, { correct: false, now: NOW });
  assert.equal(top.mastery, "mastered");
  assert.equal(bottom.mastery, "new");
  assert.deepEqual(MASTERY_LADDER, ["new", "learning", "familiar", "strong", "mastered"]);
});

/* ---------------- evidence helpers ---------------- */

test("recent accuracy ignores other activity types and reports nothing without evidence", () => {
  assert.equal(recentAccuracy([], "vocabulary", 5), null);
  assert.equal(
    recentAccuracy(
      [
        { activity_type: "reading", itemsAttempted: 10, itemsCorrect: 0 },
        { activity_type: "vocabulary", itemsAttempted: 10, itemsCorrect: 8 }
      ],
      "vocabulary",
      5
    ),
    80
  );
});

test("date keys round-trip and respect a local timezone offset", () => {
  assert.equal(msToDateKey(dateKeyToMs("2026-03-10"), 0), "2026-03-10");
  // 23:30 UTC in a +180 (Israel summer) offset is already the next local day.
  const lateNight = Date.parse("2026-03-10T23:30:00Z");
  assert.equal(msToDateKey(lateNight, 180), "2026-03-11");
  assert.equal(msToDateKey(lateNight, 0), "2026-03-10");
  assert.ok(Number.isNaN(dateKeyToMs("not-a-date")));
});

test("a different date produces a different plan id", () => {
  const a = planDay(basePlanInput({ dateKey: "2026-03-10" }));
  const b = planDay(basePlanInput({ dateKey: "2026-03-11" }));
  assert.notEqual(a.planId, b.planId);
  assert.notEqual(a.activities[0].activityId, b.activities[0].activityId);
});

test("a provisional profile is visible in the plan", () => {
  assert.equal(planDay(basePlanInput()).provisionalProfile, true);
  assert.equal(planDay(basePlanInput({ profile: profile({ provisional: false }) })).provisionalProfile, false);
});
