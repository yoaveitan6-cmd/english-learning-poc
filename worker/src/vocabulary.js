/**
 * The Vocabulary learning engine.
 *
 * ------------------------------------------------------------------------
 * ARCHITECTURAL RULE FOR THIS FILE, the same one planner.js lives by:
 * no I/O of any kind.
 *
 * Nothing here calls fetch(), touches D1, reads Date.now(), or uses
 * Math.random(). Every input arrives as an argument. That is what makes the
 * three properties this slice is judged on assertable rather than hoped for:
 *
 *   - the same learner state on the same day builds the same session,
 *   - a review interval is a consequence of evidence and nothing else,
 *   - and building a session costs zero Gemini calls by construction.
 *
 * Gemini's job is upstream of this file (write the words, write the context
 * sentences) and downstream of it (judge a free-text sentence). Choosing what
 * to practise, in what form, and when it comes back, is ordinary code.
 * ------------------------------------------------------------------------
 */

import {
  MASTERY_LADDER,
  MASTERY_INTERVAL_DAYS,
  LAPSE_THRESHOLD,
  STRUGGLING_INTERVAL_DIVISOR,
  isStruggling,
  applyVocabularyEvidence,
  hash32
} from "./planner.js";

export { isStruggling, LAPSE_THRESHOLD, STRUGGLING_INTERVAL_DIVISOR };

/* ---------------- practice modes ---------------- */

/**
 * The five MVP exercise kinds, and what each one actually asks of the learner.
 *
 * `needsAi` is about GENERATING the question, `aiEvaluated` about JUDGING the
 * answer. Three of the five need neither, which is the whole reason a session
 * is affordable on a free tier:
 *
 *   en_he            recognition. Multiple choice, built from the learner's own
 *                    Hebrew meanings. No AI at either end.
 *   he_en            recall, the harder direction. Free text, compared to the
 *                    stored term. No AI at either end.
 *   fill_blank       the word in a real sentence, with the word removed. Built
 *                    from the example sentence the item already carries.
 *   meaning_context  a NEW sentence the learner has not seen, plus four
 *                    meanings. A fresh context is genuinely generative, so this
 *                    is the one kind whose content is worth a Gemini call — and
 *                    it is batched for the whole session in a single request.
 *   write_sentence   the learner writes their own sentence. The prompt is one
 *                    line of local text; only the JUDGEMENT needs a model, and
 *                    only at the moment they submit.
 */
export const PRACTICE_KINDS = {
  en_he: {
    id: "en_he",
    label: "English → Hebrew",
    needsAi: false,
    aiEvaluated: false,
    format: "choice"
  },
  he_en: {
    id: "he_en",
    label: "Hebrew → English",
    needsAi: false,
    aiEvaluated: false,
    format: "text"
  },
  fill_blank: {
    id: "fill_blank",
    label: "Fill in the blank",
    needsAi: false,
    aiEvaluated: false,
    format: "text"
  },
  meaning_context: {
    id: "meaning_context",
    label: "Meaning in context",
    needsAi: true,
    aiEvaluated: false,
    format: "choice"
  },
  write_sentence: {
    id: "write_sentence",
    label: "Write your own sentence",
    needsAi: false,
    aiEvaluated: true,
    format: "text"
  }
};

export const PRACTICE_MODES = ["smart_mix"].concat(Object.keys(PRACTICE_KINDS));

export function isPracticeMode(v) {
  return typeof v === "string" && PRACTICE_MODES.indexOf(v) !== -1;
}

/* ---------------- session sizing ---------------- */

/**
 * How long a session may get, per session mode.
 *
 * The planner already decided how many words are due and how many are new.
 * This is only a ceiling on the resulting exercise list, because a learner
 * with a 25-word backlog should not be handed a 25-question exam inside an
 * eight-minute slot — the backlog drains over days, which is what spacing is
 * for.
 */
export const SESSION_LIMITS = {
  quick: { maxExercises: 8, depthExercises: 1 },
  standard: { maxExercises: 12, depthExercises: 2 },
  full: { maxExercises: 18, depthExercises: 3 }
};

export function sessionLimits(mode) {
  return SESSION_LIMITS[mode] || SESSION_LIMITS.standard;
}

/* ---------------- spaced repetition ---------------- */

/**
 * The MVP review schedule, in one place, in plain numbers.
 *
 * Base spacing comes from the mastery rung (planner.js owns the ladder and
 * MASTERY_INTERVAL_DAYS, because the plan needs to read them too):
 *
 *     new 0d · learning 1d · familiar 3d · strong 7d · mastered 21d
 *
 * On top of that, two rules and no more:
 *
 *   1. A wrong answer drops the word one rung, never to the bottom. Forgetting
 *      a strong word once is not the same as never having learned it — but the
 *      drop alone already brings it back much sooner (strong 7d -> familiar
 *      3d, learning 1d -> new, i.e. immediately).
 *
 *   2. A word the learner keeps getting wrong comes back at HALF the spacing
 *      its rung would normally give. Without this, a word that oscillates
 *      between familiar and strong would settle into a comfortable 3-7 day
 *      rhythm while still being unlearned. `struggling` is deliberately a
 *      blunt test — at least LAPSE_THRESHOLD failures, and no more successes
 *      than failures — so it cannot be triggered by one bad day.
 *
 * A mastered word still returns every ~3 weeks, so mastery is a claim the app
 * keeps re-checking rather than a badge. And because every step is a function
 * of the stored counters, a word can regress all the way back down if later
 * performance is poor.
 *
 * Gemini has no say in any of this, on purpose: review timing must be
 * reproducible and explainable, and a model would make it neither.
 */
/**
 * The scheduler itself lives in planner.js, beside the ladder and the interval
 * table it reads, and is re-exported here under the name the session code uses.
 * One implementation, deliberately: the pre-existing activity-completion path
 * and this slice's answer path must never be able to disagree about when a
 * word is next due.
 */
export const scheduleAfterAnswer = applyVocabularyEvidence;

/** Human-readable summary of the rules above, for /learning-config and the UI. */
export const REVIEW_RULES = {
  ladder: MASTERY_LADDER,
  intervalDays: MASTERY_INTERVAL_DAYS,
  correctAnswer: "moves the word up one rung and re-spaces it at that rung's interval",
  wrongAnswer: "moves the word down one rung — never to the bottom — so it returns much sooner",
  strugglingAfterFailures: LAPSE_THRESHOLD,
  strugglingRule: "a word with at least 3 failures and no more successes than failures comes back at half its rung's interval",
  masteredStillReturns: MASTERY_INTERVAL_DAYS.mastered + " days",
  decidedBy: "application code only — no AI call influences review timing"
};

/* ---------------- text normalisation and answer checking ---------------- */

/**
 * How two English answers are compared.
 *
 * The point is to accept what a teacher would accept and reject what they
 * would not. Case, punctuation, doubled spaces and a leading article are
 * noise; a different word is not. Anything subtler than this is exactly where
 * a deterministic comparison stops being honest — which is why the free-text
 * exercise that genuinely has many right answers is the one that asks a model.
 */
export function normalizeAnswer(s) {
  return String(s === undefined || s === null ? "" : s)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ARTICLES = ["the ", "a ", "an ", "to "];

/** A second, looser key: the same string without a leading article or `to`. */
export function answerKey(s) {
  let v = normalizeAnswer(s);
  for (const art of LEADING_ARTICLES) {
    if (v.startsWith(art)) { v = v.slice(art.length); break; }
  }
  return v;
}

/** Hebrew comparison drops the nikud and the common punctuation marks. */
export function normalizeHebrew(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/[֑-ׇ]/g, "")
    .replace(/[^\p{L}\p{N}\s'"-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic check of a typed answer against the accepted answers.
 *
 * `near` is reported separately from `correct` so the UI can say "almost —
 * check the spelling" instead of a flat wrong. A near miss is still counted as
 * a failure for scheduling purposes: the learner did not have it.
 */
export function checkTextAnswer(given, accepted, opts) {
  const hebrew = !!(opts && opts.hebrew);
  const list = (Array.isArray(accepted) ? accepted : [accepted]).filter(function (a) {
    return typeof a === "string" && a.trim().length > 0;
  });

  const norm = hebrew ? normalizeHebrew : normalizeAnswer;
  const g = norm(given);
  if (!g) return { correct: false, near: false, matched: "" };

  for (const a of list) {
    if (norm(a) === g) return { correct: true, near: false, matched: a };
  }
  if (!hebrew) {
    const gk = answerKey(given);
    for (const a of list) {
      if (answerKey(a) === gk) return { correct: true, near: false, matched: a };
    }
  }
  for (const a of list) {
    if (isNearMiss(g, norm(a))) return { correct: false, near: true, matched: a };
  }
  return { correct: false, near: false, matched: "" };
}

/**
 * One typo away. Bounded Levenshtein at distance 1 for anything long enough
 * that a single character cannot change the word entirely — "cat"/"cut" must
 * not be a near miss, "receive"/"recieve" must be.
 */
export function isNearMiss(a, b) {
  if (!a || !b) return false;
  if (a === b) return false;
  if (Math.min(a.length, b.length) < 5) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    const differing = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) differing.push(i);
      if (differing.length > 2) return false;
    }
    if (differing.length === 1) return true;
    // Two adjacent characters swapped — "recieve" for "receive" — is one typo,
    // and by far the most common one, so it counts as a near miss too.
    if (differing.length === 2 && differing[1] === differing[0] + 1) {
      return a[differing[0]] === b[differing[1]] && a[differing[1]] === b[differing[0]];
    }
    return false;
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/* ---------------- blanking a word out of its example ---------------- */

/**
 * Removes the term from its example sentence and leaves a blank.
 *
 * Matching is done on word boundaries and tolerates the simple inflections a
 * real example sentence uses — "figure out" appearing as "figured out",
 * "figuring out". If the term genuinely is not in the sentence, this returns
 * null and the caller falls back to a kind that does not need one, rather than
 * showing the learner a broken question.
 */
export function blankOutTerm(sentence, term) {
  const text = String(sentence || "");
  const raw = String(term || "").trim();
  if (!text || !raw) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const pattern = words
    .map(function (w, i) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Only the head word inflects in the phrases this app deals with
      // ("figure out", "look forward to"), so only it gets a suffix allowance.
      return i === 0 ? esc + "(?:s|es|ed|d|ing)?" : esc;
    })
    .join("\\s+");

  const re = new RegExp("(^|[^\\p{L}\\p{N}])(" + pattern + ")(?![\\p{L}\\p{N}])", "iu");
  const m = re.exec(text);
  if (!m) return null;

  const matched = m[2];
  const start = m.index + m[1].length;
  return {
    blanked: text.slice(0, start) + "_____" + text.slice(start + matched.length),
    matchedForm: matched
  };
}

/* ---------------- distractors ---------------- */

/**
 * Picks wrong-but-plausible options from the learner's other words.
 *
 * Deterministic: the pool is ordered by a stable hash of (candidate id, seed),
 * so the same session offers the same options on the Mac and on the iPhone,
 * and a refresh does not quietly reshuffle the answer the learner was halfway
 * through reading.
 */
export function pickDistractors(pool, exclude, count, seed, field) {
  const skip = new Set([].concat(exclude || []).map(function (v) { return String(v || "").trim(); }));
  const seen = new Set();
  const candidates = [];

  for (const item of pool || []) {
    const value = String((item && item[field]) || "").trim();
    if (!value) continue;
    if (skip.has(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    candidates.push({ value: value, rank: hash32(String(seed) + "|" + String(item.id) + "|" + value) });
  }

  candidates.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.value < b.value ? -1 : 1;
  });

  return candidates.slice(0, Math.max(0, count)).map(function (c) { return c.value; });
}

/** Deterministic shuffle: same seed, same order, everywhere, always. */
export function stableShuffle(values, seed) {
  return values
    .map(function (v, i) { return { v: v, r: hash32(String(seed) + "|" + i + "|" + String(v)) }; })
    .sort(function (a, b) {
      if (a.r !== b.r) return a.r - b.r;
      return String(a.v) < String(b.v) ? -1 : 1;
    })
    .map(function (x) { return x.v; });
}

/* ---------------- choosing the exercise kind ---------------- */

/**
 * Smart Mix: which kind of question this word deserves today.
 *
 * The progression mirrors how a word is actually learned. A word met for the
 * first time is shown its meaning (recognition) before being demanded back
 * (recall), and only a word the learner already half-owns is asked to be
 * produced in a sentence of their own. Asking someone to write a sentence with
 * a word they saw ninety seconds ago teaches nothing and just feels punitive.
 *
 *   new         en_he            "here is what it means"
 *   learning    he_en            "give it back to me"
 *   familiar    fill_blank       "use it in a real sentence"
 *   strong      meaning_context  "recognise it somewhere you have not seen it"
 *   mastered    write_sentence   "produce it yourself"
 *
 * A word the learner keeps failing is pulled back to recognition regardless of
 * rung — the fastest way to un-stick a stuck word is to re-teach it, not to
 * keep testing it. And the choice is filtered by what is actually available:
 * no example sentence means no fill-in-the-blank, no AI content means no
 * meaning-in-context.
 */
export function chooseKind(item, options) {
  const available = (options && options.available) || {};
  const mastery = (item && item.mastery) || "new";

  let preferred;
  if (isStruggling(item)) {
    preferred = ["en_he", "he_en", "fill_blank"];
  } else if (mastery === "new") {
    preferred = ["en_he", "he_en"];
  } else if (mastery === "learning") {
    preferred = ["he_en", "fill_blank", "en_he"];
  } else if (mastery === "familiar") {
    preferred = ["fill_blank", "he_en", "meaning_context"];
  } else if (mastery === "strong") {
    preferred = ["meaning_context", "fill_blank", "write_sentence", "he_en"];
  } else {
    preferred = ["write_sentence", "meaning_context", "fill_blank", "he_en"];
  }

  for (const kind of preferred) {
    if (available[kind]) return kind;
  }
  // he_en needs nothing but the word itself, so it is always reachable.
  return "he_en";
}

/**
 * What kinds this particular word can support right now.
 *
 *   en_he            needs a Hebrew meaning, plus enough other Hebrew meanings
 *                    to build options from. With two words in the library
 *                    there are no plausible distractors, so it is off.
 *   fill_blank       needs an example sentence the term actually appears in.
 *   meaning_context  needs AI-written content for this item.
 *   write_sentence   needs nothing, but is only worth asking of a word the
 *                    learner has some hold on.
 */
export function availableKinds(item, ctx) {
  const hebrewPoolSize = Number((ctx && ctx.hebrewPoolSize) || 0);
  const englishPoolSize = Number((ctx && ctx.englishPoolSize) || 0);
  const hasContext = !!(ctx && ctx.contextByItem && ctx.contextByItem[item.id]);
  const example = String((item && item.example) || "");
  const blank = example ? blankOutTerm(example, item.english) : null;

  return {
    en_he: !!(item.hebrew && hebrewPoolSize >= 3),
    he_en: !!item.hebrew,
    fill_blank: !!blank,
    meaning_context: hasContext && englishPoolSize >= 0,
    write_sentence: true
  };
}

/* ---------------- building the exercises ---------------- */

/**
 * Turns one word plus one chosen kind into a stored exercise.
 *
 * The returned object separates `prompt` (what the learner is shown) from
 * `answer` (what the server keeps). They are persisted as two JSON columns and
 * only the prompt half is ever serialised into a response, so the answer to
 * the current question is not sitting in the page waiting to be read.
 */
export function buildExercise(item, kind, ctx) {
  const seed = String((ctx && ctx.seed) || "") + "|" + item.id + "|" + kind;
  const pool = (ctx && ctx.pool) || [];

  if (kind === "en_he") {
    const distractors = pickDistractors(pool, [item.hebrew], 3, seed, "hebrew");
    const options = stableShuffle([item.hebrew].concat(distractors), seed);
    return {
      kind: kind,
      contentFrom: "local",
      evaluation: "deterministic",
      prompt: {
        format: "choice",
        instructionHe: "מה הפירוש של הביטוי הזה?",
        question: item.english,
        options: options
      },
      answer: { correctOption: item.hebrew }
    };
  }

  if (kind === "he_en") {
    return {
      kind: kind,
      contentFrom: "local",
      evaluation: "deterministic",
      prompt: {
        format: "text",
        instructionHe: "איך אומרים את זה באנגלית?",
        question: item.hebrew,
        placeholder: "Type the English word or phrase"
      },
      answer: { accepted: [item.english] }
    };
  }

  if (kind === "fill_blank") {
    const blank = blankOutTerm(item.example, item.english);
    if (!blank) return null;
    return {
      kind: kind,
      contentFrom: "local",
      evaluation: "deterministic",
      prompt: {
        format: "text",
        instructionHe: "השלימו את המילה או הביטוי החסר.",
        question: blank.blanked,
        hintHe: item.hebrew || "",
        placeholder: "Fill the blank"
      },
      // Both the dictionary form and the inflected form as it appears in the
      // sentence are right; the learner is being tested on the word, not on
      // guessing which tense the example happened to use.
      answer: { accepted: [item.english, blank.matchedForm] }
    };
  }

  if (kind === "meaning_context") {
    const content = ctx && ctx.contextByItem && ctx.contextByItem[item.id];
    if (!content || !content.sentence || !content.correctMeaning) return null;
    const wrong = (Array.isArray(content.wrongMeanings) ? content.wrongMeanings : []).slice(0, 3);
    if (wrong.length < 2) return null;
    const options = stableShuffle([content.correctMeaning].concat(wrong), seed);
    return {
      kind: kind,
      contentFrom: "gemini",
      evaluation: "deterministic",
      prompt: {
        format: "choice",
        instructionHe: "מה משמעות המילה המודגשת במשפט הזה?",
        question: content.sentence,
        term: item.english,
        options: options
      },
      answer: { correctOption: content.correctMeaning }
    };
  }

  if (kind === "write_sentence") {
    return {
      kind: kind,
      contentFrom: "local",
      // The only kind whose answer a model judges, and only when submitted.
      evaluation: "ai",
      prompt: {
        format: "text",
        instructionHe: "כתבו משפט אחד משלכם שמשתמש בביטוי הזה.",
        question: item.english,
        hintHe: item.hebrew || "",
        placeholder: "Write one sentence"
      },
      answer: { term: item.english }
    };
  }

  return null;
}

/* ---------------- composing the session ---------------- */

/**
 * Builds the whole exercise list for one session.
 *
 * The order is deliberate and is the lesson's shape:
 *
 *   1. New words first, while attention is freshest, one recognition question
 *      each. Introducing a word IS the exercise; the recall demand comes on a
 *      later day, which is what the scheduler is for.
 *   2. Then the review queue, most overdue first (the planner already ranked
 *      them), each in whatever form its mastery calls for.
 *   3. Then, if there is room left in the session's ceiling, a few depth
 *      questions on the words the learner knows best — this is where
 *      meaning-in-context and write-your-own-sentence live.
 *
 * In a focused mode the learner has overridden step 3 and steps 1-2's choice
 * of kind: every item gets the requested kind, and any item that cannot
 * support it is skipped rather than silently downgraded.
 */
export function composeSession(input) {
  const mode = input.mode;
  const limits = sessionLimits(mode);
  const practiceMode = isPracticeMode(input.practiceMode) ? input.practiceMode : "smart_mix";
  const focused = practiceMode !== "smart_mix";
  const seed = String(input.sessionKey || "");

  const newItems = Array.isArray(input.newItems) ? input.newItems : [];
  const reviewItems = Array.isArray(input.reviewItems) ? input.reviewItems : [];
  const pool = newItems.concat(reviewItems).concat(Array.isArray(input.pool) ? input.pool : []);

  const hebrewPoolSize = countDistinct(pool, "hebrew");
  const englishPoolSize = countDistinct(pool, "english");
  const ctx = {
    seed: seed,
    pool: pool,
    contextByItem: input.contextByItem || {},
    hebrewPoolSize: hebrewPoolSize,
    englishPoolSize: englishPoolSize
  };

  const exercises = [];
  const usedItems = new Set();

  function add(item, kind) {
    if (exercises.length >= limits.maxExercises) return false;
    const available = availableKinds(item, ctx);
    const chosen = focused ? kind : chooseKind(item, { available: available });
    if (focused && !available[chosen]) return false;
    const built = buildExercise(item, chosen, ctx);
    if (!built) return false;
    exercises.push(
      Object.assign({ position: exercises.length, itemId: item.id }, built)
    );
    usedItems.add(item.id);
    return true;
  }

  for (const item of newItems) add(item, practiceMode);
  for (const item of reviewItems) add(item, practiceMode);

  /* Second pass, Smart Mix only, and only with a DIFFERENT kind than the word's
     first question — asking the same question twice teaches nothing.

     Two groups, in this order, because they earn the remaining room in this
     order:

       reinforcement  every word introduced today gets a recall question after
                      its recognition one. Meeting a word once is not learning
                      it; being made to produce it, minutes later, is where it
                      starts to stick. This is also what stops a day with no
                      review backlog from being five identical questions.

       depth          words the learner already owns get a harder form —
                      meaning-in-context or writing their own sentence.

     Both are bounded by the session's exercise ceiling, so on a day with a real
     review backlog the reviews keep their place and this pass simply does not
     run. Reviews are the priority; extras are extras. */
  if (!focused) {
    for (const item of newItems) {
      if (exercises.length >= limits.maxExercises) break;
      if (!usedItems.has(item.id)) continue;
      addSecondForm(item, ["he_en", "fill_blank"]);
    }

    const deep = reviewItems
      .filter(function (v) {
        const m = v.mastery || "new";
        return (m === "familiar" || m === "strong" || m === "mastered") && !isStruggling(v);
      })
      .slice(0, limits.depthExercises);

    for (const item of deep) {
      if (exercises.length >= limits.maxExercises) break;
      addSecondForm(item, ["write_sentence", "meaning_context", "fill_blank", "he_en"]);
    }
  }

  function addSecondForm(item, order) {
    const available = availableKinds(item, ctx);
    const already = exercises
      .filter(function (e) { return e.itemId === item.id; })
      .map(function (e) { return e.kind; });
    for (const kind of order) {
      if (already.indexOf(kind) !== -1) continue;
      if (!available[kind]) continue;
      const built = buildExercise(item, kind, ctx);
      if (!built) continue;
      exercises.push(Object.assign({ position: exercises.length, itemId: item.id }, built));
      return true;
    }
    return false;
  }

  return {
    practiceMode: practiceMode,
    exercises: exercises,
    /* The completion rule, and it is deliberately the blunt one: every question
       in the session has to be answered. It cannot be gamed, it needs no
       explanation beyond the "4 of 9" counter the learner is already looking
       at, and because the list length is capped above, "all of them" is always
       a reasonable ask. Right or wrong does not matter — attempting is the
       work; being right is what the scheduler reads. */
    requiredExercises: exercises.length,
    introducedItemIds: newItems
      .filter(function (v) { return usedItems.has(v.id); })
      .map(function (v) { return v.id; })
  };
}

function countDistinct(items, field) {
  const seen = new Set();
  for (const it of items || []) {
    const v = String((it && it[field]) || "").trim();
    if (v) seen.add(v);
  }
  return seen.size;
}

/* ---------------- completion ---------------- */

/**
 * Has the learner done enough for this to count as a finished session?
 *
 * Two conditions, both visible in the UI: every new word was actually
 * introduced, and every question was attempted. The first is what stops "I
 * pressed done" from counting as learning five new words.
 */
export function evaluateCompletion(session, attempts) {
  const attempted = new Set();
  const attemptedItems = new Set();
  for (const a of attempts || []) {
    attempted.add(a.exercise_id);
    attemptedItems.add(a.item_id);
  }

  const required = Math.max(0, Number(session.requiredExercises) || 0);
  const introduced = (Array.isArray(session.introducedItemIds) ? session.introducedItemIds : [])
    .filter(function (id) { return attemptedItems.has(id); });
  const newIds = Array.isArray(session.newItemIds) ? session.newItemIds : [];
  const missingIntroductions = newIds.filter(function (id) { return !attemptedItems.has(id); });

  const enoughAttempts = attempted.size >= required;
  const allIntroduced = missingIntroductions.length === 0;

  return {
    ready: enoughAttempts && allIntroduced,
    attempted: attempted.size,
    required: required,
    introduced: introduced.length,
    missingIntroductions: missingIntroductions,
    ruleHe: "כדי לסיים: לענות על כל השאלות בסשן, ולפגוש כל מילה חדשה לפחות פעם אחת.",
    rule: "Every question in the session must be attempted, and every new word must be met at least once."
  };
}

/**
 * Turns the finished attempts into the summary the learner reads and the
 * numbers Today's Plan records.
 *
 * "Improved" and "needs more review" are stated per word rather than as one
 * accuracy percentage, because a learner wants to know WHICH words to worry
 * about, not that they scored 71%.
 */
export function summariseSession(session, attempts, itemsById) {
  const byItem = new Map();
  for (const a of attempts || []) {
    const cur = byItem.get(a.item_id) || { correct: 0, wrong: 0 };
    if (Number(a.correct) === 1) cur.correct++;
    else cur.wrong++;
    byItem.set(a.item_id, cur);
  }

  const newIds = new Set(Array.isArray(session.newItemIds) ? session.newItemIds : []);
  const introduced = [];
  const improved = [];
  const needsReview = [];

  const ids = [...byItem.keys()].sort();
  for (const id of ids) {
    const r = byItem.get(id);
    const item = (itemsById && itemsById[id]) || { id: id, english: id, hebrew: "" };
    const entry = { id: id, english: item.english, hebrew: item.hebrew };
    if (newIds.has(id)) introduced.push(entry);
    if (r.wrong > 0) needsReview.push(entry);
    else if (r.correct > 0 && !newIds.has(id)) improved.push(entry);
  }

  let attempted = 0;
  let correct = 0;
  for (const a of attempts || []) {
    attempted++;
    if (Number(a.correct) === 1) correct++;
  }

  return {
    itemsAttempted: attempted,
    itemsCorrect: correct,
    accuracy: attempted > 0 ? Math.round((correct / attempted) * 100) : 0,
    introduced: introduced,
    improved: improved,
    needsReview: needsReview
  };
}
