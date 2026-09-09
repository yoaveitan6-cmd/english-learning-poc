/**
 * Sentence Practice / Grammar — the second real learning activity.
 *
 * ------------------------------------------------------------------------
 * ARCHITECTURAL RULE FOR THIS FILE, the same one planner.js and vocabulary.js
 * live by: no I/O of any kind.
 *
 * Nothing here calls fetch(), touches D1, reads Date.now(), or uses
 * Math.random(). Every input arrives as an argument, which is what makes
 * "the same targets and item count build the same slot plan" and "grading is
 * a pure function of the stored answer" assertable rather than hoped for.
 *
 * Division of labour, unchanged from every other slice: planner.js has
 * already chosen WHICH grammar targets today's session covers (it merges
 * recurring weaknesses with the coverage curriculum — see
 * selectGrammarTargets) and HOW MANY items the session should have
 * (spec.itemCount, sized by session mode). This file turns that decision
 * into a deterministic slot plan — which target, which exercise type, how
 * many base items, how many reinforcement items in reserve — and Gemini's
 * job (in sentence_routes.js) is only to write CONTENT for the slots this
 * file already planned. No AI call chooses what to practise or how much.
 * ------------------------------------------------------------------------
 */

import { checkTextAnswer, normalizeAnswer } from "./vocabulary.js";

export { normalizeAnswer };

/* ---------------- exercise types ---------------- */

/**
 * The five MVP exercise kinds (product spec §5):
 *   fill_blank      a sentence with the target grammar point blanked out,
 *                    multiple choice among 2-4 forms.
 *   choice           two (occasionally more) whole sentences; the learner
 *                    picks the correct/more natural one.
 *   correction       an incorrect sentence; the learner types the fix.
 *   transformation   rewrite one sentence per an instruction (e.g. "using
 *                    Present Perfect").
 *   free_sentence    the learner writes their own sentence using the target.
 */
export const EXERCISE_TYPES = ["fill_blank", "choice", "correction", "transformation", "free_sentence"];

export const TYPE_LABELS = {
  fill_blank: "Fill in the blank",
  choice: "Choose the correct sentence",
  correction: "Correct the sentence",
  transformation: "Sentence transformation",
  free_sentence: "Write your own sentence"
};

export function isExerciseType(v) {
  return typeof v === "string" && EXERCISE_TYPES.indexOf(v) !== -1;
}

/**
 * fill_blank and choice are always deterministic — both are multiple choice
 * over model-supplied options, exactly like Vocabulary's en_he kind.
 * free_sentence is always AI-evaluated — it is genuinely open-ended.
 * correction and transformation are decided per-item (see
 * evaluationForExercise) because whether a tight, safe set of accepted
 * answers exists varies item to item.
 */
export function evaluationForExercise(type, entry) {
  if (type === "fill_blank" || type === "choice") return "deterministic";
  if (type === "free_sentence") return "ai";

  const accepted = (entry && Array.isArray(entry.acceptedAnswers) ? entry.acceptedAnswers : [])
    .filter(function (a) { return typeof a === "string" && a.trim().length > 0; });

  if (type === "correction") {
    // "Deterministic where safely possible": a correction with no usable
    // accepted-answer set falls back to AI rather than grading against nothing.
    return accepted.length >= 1 ? "deterministic" : "ai";
  }
  if (type === "transformation") {
    // A transformation is deterministic only when the model both declares it
    // safe AND supplies a small, tight set of accepted forms. A transformation
    // genuinely admits many valid rewrites more often than a correction does,
    // so the bar here is stricter — this is what keeps "meaning-changing
    // answer rejected" honest instead of accepting anything loosely similar.
    const safe = entry && entry.deterministicSafe === true;
    return safe && accepted.length >= 1 && accepted.length <= 4 ? "deterministic" : "ai";
  }
  return "ai";
}

/* ---------------- slot planning ---------------- */

/** One reserve (reinforcement) exercise per target, generated in the same
    batch as the base exercises so a missed answer never needs a second
    Gemini call. */
export const RESERVE_PER_TARGET = 1;

/** At most one reinforcement exercise is ever activated per target per
    session — the reserve pool only has one to activate anyway, but the
    constant makes the cap explicit and testable on its own. */
export const REINFORCEMENT_CAP_PER_TARGET = 1;

/**
 * Turns "these targets, this many items" into a deterministic list of slots,
 * each naming a target and a requested exercise type. Two targets and a mix
 * of types is the shape that satisfies §5 ("the mix should depend on target
 * and learner state") without leaving the choice to the model.
 *
 * Items are split as evenly as possible across targets (first targets absorb
 * the remainder), and each target's types cycle through EXERCISE_TYPES
 * starting at an offset that depends on the target's position — so with two
 * targets and six items, the two targets do not end up requesting identical
 * type sequences.
 */
export function planSlots(targets, itemCount) {
  const list = Array.isArray(targets) ? targets.filter(function (t) { return t && t.id; }) : [];
  if (!list.length) return [];

  const total = Math.max(list.length, Math.round(Number(itemCount) || 0));
  const base = Math.floor(total / list.length);
  const remainder = total - base * list.length;

  const slots = [];
  let n = 0;
  for (let t = 0; t < list.length; t++) {
    const target = list[t];
    const count = base + (t < remainder ? 1 : 0);
    for (let s = 0; s < count; s++) {
      slots.push({
        slotIndex: n++,
        target_id: target.id,
        target_label: target.label,
        target_status: target.status || "observed",
        target_kind: target.kind || "learner",
        requestedType: EXERCISE_TYPES[(t + s) % EXERCISE_TYPES.length],
        pool: "base"
      });
    }
    for (let r = 0; r < RESERVE_PER_TARGET; r++) {
      slots.push({
        slotIndex: n++,
        target_id: target.id,
        target_label: target.label,
        target_status: target.status || "observed",
        target_kind: target.kind || "learner",
        requestedType: EXERCISE_TYPES[(t + count + r) % EXERCISE_TYPES.length],
        pool: "reserve"
      });
    }
  }
  return slots;
}

/* ---------------- reinforcement ---------------- */

/** The one un-activated reserve exercise for this target, if any — the
    candidate POST .../answer activates when a base exercise for the same
    target is missed. Deterministic ordering (by exercise_id, which encodes
    generation order) so which exercise is chosen never depends on request
    timing. */
export function findReserveExercise(exercises, targetId) {
  const candidates = (exercises || []).filter(function (e) {
    return e.pool === "reserve" && Number(e.active) === 0 && e.target_id === targetId;
  });
  candidates.sort(function (a, b) { return a.exercise_id < b.exercise_id ? -1 : 1; });
  return candidates[0] || null;
}

/** How many reserve exercises for this target have already been activated
    this session — the cap check before activating another. */
export function reinforcementActivatedCount(exercises, targetId) {
  return (exercises || []).filter(function (e) {
    return e.pool === "reserve" && e.target_id === targetId && Number(e.active) === 1;
  }).length;
}

/* ---------------- answer checking ---------------- */

const CONTRACTIONS = {
  "don't": "do not", "doesn't": "does not", "didn't": "did not",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
  "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
  "won't": "will not", "wouldn't": "would not", "can't": "can not", "cannot": "can not",
  "couldn't": "could not", "shouldn't": "should not", "mustn't": "must not",
  "i'm": "i am", "we're": "we are", "you're": "you are", "they're": "they are",
  "i've": "i have", "we've": "we have", "you've": "you have", "they've": "they have",
  "i'll": "i will", "we'll": "we will", "you'll": "you will", "they'll": "they will"
};

/**
 * Expands the unambiguous contractions ("don't" -> "do not") so a learner who
 * writes either form is not marked wrong for a difference that carries no
 * meaning. Deliberately skips the ambiguous ones ('s = is/has, 'd = would/had)
 * rather than guessing which expansion the learner meant.
 */
export function normalizeContractions(s) {
  let out = String(s === undefined || s === null ? "" : s).toLowerCase().replace(/[‘’ʼ]/g, "'");
  for (const k of Object.keys(CONTRACTIONS)) {
    const re = new RegExp("\\b" + k.replace(/'/g, "['’]") + "\\b", "g");
    out = out.replace(re, CONTRACTIONS[k]);
  }
  return out;
}

/** Multiple-choice grading for fill_blank and choice: the learner's answer is
    the exact option text they tapped, compared loosely (case/whitespace) in
    case a client re-sends a slightly re-rendered string. */
export function checkOptionAnswer(given, correctOption) {
  return normalizeAnswer(given) === normalizeAnswer(correctOption) && normalizeAnswer(given).length > 0;
}

/**
 * Free-text grading for correction and deterministic transformations: compares
 * against every accepted surface form after normalizing case, punctuation,
 * whitespace and unambiguous contractions. This is deliberately the same
 * ceiling as Vocabulary's checkTextAnswer — a different word is wrong, a typo
 * is "near" but still not correct, and nothing here tries to understand
 * meaning, which is exactly why a genuinely open answer routes to AI instead.
 */
export function checkSentenceAnswer(given, accepted) {
  const list = (Array.isArray(accepted) ? accepted : [accepted]).filter(function (a) {
    return typeof a === "string" && a.trim().length > 0;
  });
  return checkTextAnswer(normalizeContractions(given), list.map(normalizeContractions), { hebrew: false });
}

/* ---------------- completion ---------------- */

/**
 * Has the learner done enough for this to count as a finished session?
 *
 * The rule is deliberately the same shape as Vocabulary's: every exercise
 * CURRENTLY in the active set must be attempted. What makes this different
 * from Vocabulary is that the active set can grow mid-session — activating a
 * reinforcement exercise raises `required` by one, so the learner must also
 * attempt the follow-up before the session can be marked done.
 */
export function evaluateCompletion(exercises, attempts) {
  const active = (exercises || []).filter(function (e) { return Number(e.active) === 1; });
  const attemptedIds = new Set((attempts || []).map(function (a) { return a.exercise_id; }));
  let attemptedCount = 0;
  for (const e of active) {
    if (attemptedIds.has(e.exercise_id)) attemptedCount++;
  }
  const required = active.length;
  return {
    ready: required > 0 && attemptedCount >= required,
    attempted: attemptedCount,
    required: required,
    rule: "Every exercise currently in the session must be attempted, including any follow-up exercise added after a missed answer.",
    ruleHe: "כדי לסיים: לענות על כל התרגילים שבסשן, כולל כל תרגיל חיזוק שנוסף אחרי טעות."
  };
}

/* ---------------- summary ---------------- */

/**
 * Turns the finished attempts into the summary the learner reads and the
 * per-target evidence Today's Plan records.
 *
 * A target is "strong today" only if every attempt against it in this session
 * was correct, and "needs more work" if any attempt was wrong — one session
 * is not proof of mastery either way, which is why the UI wording (built from
 * this data, not invented here) says "we'll revisit" rather than "mastered".
 */
export function summariseSession(targets, exercises, attempts) {
  const exById = new Map();
  for (const e of exercises || []) exById.set(e.exercise_id, e);

  const byTarget = new Map();
  let attempted = 0;
  let correct = 0;
  for (const a of attempts || []) {
    const ex = exById.get(a.exercise_id);
    if (!ex || Number(ex.active) !== 1) continue;
    attempted++;
    const ok = Number(a.correct) === 1;
    if (ok) correct++;
    const cur = byTarget.get(a.target_id) || { correct: 0, wrong: 0 };
    if (ok) cur.correct++; else cur.wrong++;
    byTarget.set(a.target_id, cur);
  }

  function labelFor(id) {
    const t = (targets || []).find(function (x) { return x.id === id; });
    return (t && t.label) || id;
  }

  const strong = [];
  const needsWork = [];
  const ids = [...byTarget.keys()].sort();
  for (const id of ids) {
    const r = byTarget.get(id);
    const entry = { id: id, label: labelFor(id), correct: r.correct, wrong: r.wrong };
    if (r.wrong === 0) strong.push(entry);
    else needsWork.push(entry);
  }

  return {
    itemsAttempted: attempted,
    itemsCorrect: correct,
    accuracy: attempted > 0 ? Math.round((correct / attempted) * 100) : 0,
    strong: strong,
    needsWork: needsWork
  };
}
