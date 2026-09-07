/**
 * Deterministic learning engine.
 *
 * ------------------------------------------------------------------------
 * ARCHITECTURAL RULE FOR THIS FILE: no I/O of any kind.
 *
 * Nothing here calls fetch(), touches D1, reads Date.now(), or uses
 * Math.random(). Every input arrives as an argument and every output is
 * derived from those arguments alone. That is what makes "the same learner
 * state on the same day produces the same plan" a property we can assert
 * rather than hope for, and it is why generating Today's Plan costs zero
 * Gemini calls.
 *
 * Division of labour with the AI, deliberately:
 *   this file decides WHAT the learner should practise today;
 *   Gemini (later, in a different slice) will generate CONTENT for it.
 * Letting a model choose the plan would make learning behaviour drift between
 * days, make it unexplainable, and spend free-tier quota on a decision that
 * ordinary code makes better.
 * ------------------------------------------------------------------------
 */

/* ---------------- session modes ---------------- */

/**
 * Standard is the product's normal day (~30 min) and is the mode this slice is
 * tuned for. Quick and Full exist so the allocation logic is already shaped by
 * duration rather than retrofitted later.
 *
 * Reading is absent from Quick on purpose: a passage plus comprehension needs a
 * contiguous block, and squeezing it into three minutes produces a worse
 * activity than leaving it out. Listening is not a module at all — it belongs
 * inside Reading and Speaking.
 */
export const SESSION_MODES = {
  quick: {
    id: "quick",
    label: "Quick",
    targetMinutes: 13,
    modules: ["vocabulary", "sentence_practice", "speaking"],
    minutes: { vocabulary: 5, sentence_practice: 4, speaking: 4, reading: 0, writing: 0 },
    newWordFactor: 0.6,
    reviewCapacity: 6,
    grammarSlots: 1,
    includeWritingWhenDue: false
  },
  standard: {
    id: "standard",
    label: "Standard",
    targetMinutes: 30,
    modules: ["vocabulary", "sentence_practice", "reading", "speaking"],
    minutes: { vocabulary: 8, sentence_practice: 8, reading: 7, speaking: 7, writing: 6 },
    newWordFactor: 1,
    reviewCapacity: 10,
    grammarSlots: 2,
    includeWritingWhenDue: true
  },
  full: {
    id: "full",
    label: "Full",
    targetMinutes: 52,
    modules: ["vocabulary", "sentence_practice", "reading", "speaking"],
    minutes: { vocabulary: 12, sentence_practice: 12, reading: 12, speaking: 12, writing: 10 },
    newWordFactor: 1.4,
    reviewCapacity: 15,
    grammarSlots: 2,
    includeWritingWhenDue: true
  }
};

export const DEFAULT_MODE = "standard";
export const GENERATOR = "deterministic-v1";

export function isMode(v) {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SESSION_MODES, v);
}

/* ---------------- vocabulary tuning ---------------- */

export const VOCAB_RULES = {
  baseNewWords: 5,          // the product's stated default for a Standard day
  minNewWords: 0,
  maxNewWords: 8,           // hard ceiling; the MVP never grows without bound
  backlog: [
    // { atLeast: due items, factor } — first match wins, checked top-down.
    { atLeast: 25, factor: 0 },     // drowning: stop adding, clear the backlog
    { atLeast: 15, factor: 0.4 },
    { atLeast: 8, factor: 0.7 }
  ],
  weakAccuracyBelow: 60,    // recent vocabulary accuracy under this -> fewer new words
  weakFactor: 0.6,
  strongAccuracyAbove: 85,  // strong AND a small backlog -> a modest increase
  strongBacklogAtMost: 5,
  strongFactor: 1.4,
  recentSessionWindow: 5    // how many recent vocabulary sessions count as "recent"
};

/* Mastery ladder. Progression is by consecutive successes; one failure drops a
   word one rung rather than to the bottom, because a single slip on a word you
   mostly know is not the same as never having learned it. */
export const MASTERY_LADDER = ["new", "learning", "familiar", "strong", "mastered"];

/* Spacing per mastery rung, in days. Plain and legible on purpose — this is a
   small personal app, not an SRS research project. */
export const MASTERY_INTERVAL_DAYS = {
  new: 0,
  learning: 1,
  familiar: 3,
  strong: 7,
  mastered: 21
};

/* ---------------- learning target lifecycle ---------------- */

export const TARGET_STATUSES = ["observed", "needs_work", "improving", "monitoring"];

/**
 * Thresholds for the recurring-mistake lifecycle. These are intentionally
 * blunt integers, not a model.
 *
 *   observed    a mistake has been seen. One slip lives here and goes no
 *               further — this is the rule that stops a typo becoming a
 *               "recurring weakness" that hijacks tomorrow's plan.
 *   needs_work  enough repeated evidence to spend plan time on it.
 *   improving   the learner is now getting it right more than wrong.
 *   monitoring  looks fixed; kept around so a relapse is detectable.
 *
 * Promotion out of `observed` needs BOTH enough errors AND errors on more than
 * one day, so three errors inside one unlucky sentence are still one slip.
 */
export const TARGET_RULES = {
  promoteErrors: 3,          // recentErrors needed to reach needs_work
  promoteErrorDays: 2,       // ...on at least this many distinct days
  improvingSuccesses: 3,     // recentSuccesses needed to leave needs_work
  monitoringSuccesses: 6,    // recentSuccesses needed to reach monitoring
  monitoringQuietDays: 14,   // ...with no error in this many days
  relapseErrors: 2           // recentErrors that send improving/monitoring back to needs_work
};

/* ---------------- topics ---------------- */

/**
 * A small fixed catalogue. Today's topic is a deterministic rotation over it,
 * so the learner gets variety across days while any given day is reproducible.
 * When the learner has stated interests, the rotation runs over those instead.
 */
export const TOPICS = [
  { slug: "travel_experiences", label: "Travel & Experiences" },
  { slug: "work_career", label: "Work & Career" },
  { slug: "food_cooking", label: "Food & Cooking" },
  { slug: "technology_daily_life", label: "Technology & Daily Life" },
  { slug: "health_habits", label: "Health & Habits" },
  { slug: "culture_media", label: "Culture & Media" },
  { slug: "money_decisions", label: "Money & Decisions" },
  { slug: "relationships_people", label: "People & Relationships" },
  { slug: "learning_ideas", label: "Learning & Ideas" },
  { slug: "city_environment", label: "City & Environment" }
];

/**
 * Coverage curriculum. Without this the learner would only ever practise
 * mistakes they happened to make, which leaves permanent blind spots. These
 * fill grammar slots that recurring weaknesses do not claim, and they are the
 * whole plan for a learner who has no error history yet.
 */
export const CURRICULUM = [
  { id: "past_simple", label: "Past Simple", category: "grammar" },
  { id: "present_perfect", label: "Present Perfect", category: "grammar" },
  { id: "articles", label: "Articles", category: "grammar" },
  { id: "prepositions", label: "Prepositions", category: "grammar" },
  { id: "word_order", label: "Word Order", category: "grammar" },
  { id: "subject_verb_agreement", label: "Subject-Verb Agreement", category: "grammar" },
  { id: "conditionals", label: "Conditionals", category: "grammar" },
  { id: "spelling", label: "Spelling", category: "usage" },
  { id: "vocabulary_choice", label: "Vocabulary Choice", category: "vocabulary" },
  { id: "naturalness", label: "Naturalness", category: "usage" }
];

/** Maps the free-text labels Gemini returns in errorTypes onto target ids. */
export function targetIdFromLabel(label) {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!slug) return "";
  const aliases = {
    tense: "past_simple",
    tenses: "past_simple",
    past_tense: "past_simple",
    article: "articles",
    preposition: "prepositions",
    agreement: "subject_verb_agreement",
    word_choice: "vocabulary_choice",
    vocabulary: "vocabulary_choice",
    natural: "naturalness",
    fluency: "naturalness"
  };
  return aliases[slug] || slug;
}

export function labelForTargetId(id) {
  const known = CURRICULUM.find(function (c) { return c.id === id; });
  if (known) return known.label;
  return String(id || "")
    .split("_")
    .filter(Boolean)
    .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
    .join(" ");
}

/* ---------------- small deterministic primitives ---------------- */

/* FNV-1a. Used only to spread topic choice across owners and days. It is not
   security-relevant; it just has to be stable everywhere and never random. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' -> epoch ms at UTC midnight. Returns NaN for a bad key. */
export function dateKeyToMs(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return NaN;
  const ms = Date.parse(dateKey + "T00:00:00Z");
  return Number.isFinite(ms) ? ms : NaN;
}

/** epoch ms + a local offset (minutes east of UTC) -> 'YYYY-MM-DD' local day. */
export function msToDateKey(ms, offsetMinutes) {
  const shifted = new Date(Number(ms) + (Number(offsetMinutes) || 0) * 60000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function daysBetween(laterMs, earlierMs) {
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return Infinity;
  return Math.floor((laterMs - earlierMs) / DAY_MS);
}

/* ---------------- vocabulary selection ---------------- */

/**
 * A word is due when it has never been practised (no state row, or dueAt null)
 * or its dueAt has passed. Rejected suggestions and items still awaiting
 * approval are never scheduled.
 */
export function isDue(item, now) {
  if (!item) return false;
  if (item.approval === "rejected" || item.approval === "pending") return false;
  if (item.dueAt === null || item.dueAt === undefined) return true;
  return Number(item.dueAt) <= now;
}

export function isNewItem(item) {
  return !item.lastPracticedAt && (item.mastery === "new" || !item.mastery);
}

/**
 * How many brand-new words to introduce today.
 *
 * The shape: a base of 5 for a Standard day, scaled by session length, cut
 * when there is a review backlog or recent vocabulary accuracy is poor, and
 * allowed a modest lift only when the learner is both accurate and caught up.
 * Clamped to 0..8 so it can never run away.
 */
export function newWordTarget(opts) {
  const mode = SESSION_MODES[opts.mode] || SESSION_MODES[DEFAULT_MODE];
  const dueCount = Math.max(0, Number(opts.dueCount) || 0);
  const accuracy = opts.recentVocabAccuracy;   // null when there is no evidence yet
  const reasons = [];

  let value = VOCAB_RULES.baseNewWords * mode.newWordFactor;

  let backlogFactor = 1;
  for (const rule of VOCAB_RULES.backlog) {
    if (dueCount >= rule.atLeast) { backlogFactor = rule.factor; break; }
  }
  if (backlogFactor !== 1) {
    reasons.push(
      dueCount + " words are due for review, so fewer new words today" +
      (backlogFactor === 0 ? " — clear the backlog first." : ".")
    );
  }
  value *= backlogFactor;

  let performanceFactor = 1;
  if (typeof accuracy === "number") {
    if (accuracy < VOCAB_RULES.weakAccuracyBelow) {
      performanceFactor = VOCAB_RULES.weakFactor;
      reasons.push("Recent vocabulary accuracy was " + Math.round(accuracy) + "%, so today consolidates instead of expanding.");
    } else if (accuracy > VOCAB_RULES.strongAccuracyAbove && dueCount <= VOCAB_RULES.strongBacklogAtMost) {
      performanceFactor = VOCAB_RULES.strongFactor;
      reasons.push("Recent vocabulary accuracy was " + Math.round(accuracy) + "% with almost no backlog, so a few extra new words.");
    }
  }
  value *= performanceFactor;

  const count = clamp(Math.round(value), VOCAB_RULES.minNewWords, VOCAB_RULES.maxNewWords);
  return { count: count, backlogFactor: backlogFactor, performanceFactor: performanceFactor, reasons: reasons };
}

/**
 * Ranks due items. Order: most overdue first, then weakest mastery, then id —
 * the trailing id comparison is what removes the last trace of nondeterminism
 * when two words are otherwise identical.
 */
function rankDue(items, now) {
  return items.slice().sort(function (a, b) {
    const aDue = a.dueAt === null || a.dueAt === undefined ? 0 : Number(a.dueAt);
    const bDue = b.dueAt === null || b.dueAt === undefined ? 0 : Number(b.dueAt);
    if (aDue !== bDue) return aDue - bDue;
    const aM = MASTERY_LADDER.indexOf(a.mastery || "new");
    const bM = MASTERY_LADDER.indexOf(b.mastery || "new");
    if (aM !== bM) return aM - bM;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ---------------- learning target ranking ---------------- */

const STATUS_WEIGHT = {
  needs_work: 100,
  improving: 55,
  observed: 40,
  monitoring: 25
};

/** A never-practised curriculum item outranks a settled `monitoring` target
    but never outranks an active weakness. */
const CURRICULUM_BASE_SCORE = 30;

/**
 * Scores one target. Higher wins. Every term is integer arithmetic on stored
 * fields, so the ranking is reproducible and, more importantly, explainable:
 * `reason` is what the UI can show the learner.
 */
export function scoreTarget(target, now) {
  const status = TARGET_STATUSES.indexOf(target.status) === -1 ? "observed" : target.status;
  let score = STATUS_WEIGHT[status];

  const recentErrors = Math.max(0, Number(target.recentErrors) || 0);
  const recentSuccesses = Math.max(0, Number(target.recentSuccesses) || 0);
  score += Math.min(recentErrors, 5) * 8;
  score -= Math.min(recentSuccesses, 5) * 4;

  const sinceError = daysBetween(now, Number(target.lastErrorAt));
  if (sinceError <= 7) score += 15;
  else if (sinceError <= 21) score += 7;

  // Rotation pressure: something untouched for a while edges ahead of an
  // equally-weighted target practised yesterday.
  const sincePractice = Number.isFinite(Number(target.lastPracticedAt))
    ? daysBetween(now, Number(target.lastPracticedAt))
    : 14;
  score += Math.min(Math.max(sincePractice, 0), 14) * 1.5;

  return Math.round(score);
}

function targetReason(target) {
  if (target.kind === "curriculum") {
    return labelForTargetId(target.target_id) + " has not been practised yet (coverage).";
  }
  const errors = Math.max(0, Number(target.recentErrors) || 0);
  if (target.status === "needs_work") {
    return labelForTargetId(target.target_id) + " is a recurring weakness (" + errors + " recent errors).";
  }
  if (target.status === "improving") {
    return labelForTargetId(target.target_id) + " is improving and worth reinforcing.";
  }
  if (target.status === "monitoring") {
    return labelForTargetId(target.target_id) + " looks fixed; checking it still holds.";
  }
  return labelForTargetId(target.target_id) + " has been observed " + errors + " time(s) recently.";
}

/**
 * Merges the learner's own targets with the coverage curriculum into one
 * ranking, then takes the top `slots`.
 *
 * One ranked list rather than two queues is what lets weaknesses take
 * precedence while still guaranteeing coverage: a learner with two active
 * weaknesses practises both, a learner with one gets that one plus a
 * curriculum item, and a learner with none gets pure curriculum.
 */
export function selectGrammarTargets(targets, slots, now) {
  const known = new Map();
  for (const t of targets || []) known.set(t.target_id, t);

  const pool = [];
  for (const t of targets || []) {
    pool.push({
      target_id: t.target_id,
      label: t.label || labelForTargetId(t.target_id),
      category: t.category || "grammar",
      status: t.status || "observed",
      recentErrors: t.recentErrors,
      recentSuccesses: t.recentSuccesses,
      lastErrorAt: t.lastErrorAt,
      lastPracticedAt: t.lastPracticedAt,
      kind: "learner"
    });
  }
  for (const c of CURRICULUM) {
    if (known.has(c.id)) continue;   // already represented by real evidence
    pool.push({
      target_id: c.id,
      label: c.label,
      category: c.category,
      status: "observed",
      recentErrors: 0,
      recentSuccesses: 0,
      lastErrorAt: null,
      lastPracticedAt: null,
      kind: "curriculum"
    });
  }

  const scored = pool.map(function (t) {
    const base = t.kind === "curriculum" ? CURRICULUM_BASE_SCORE : scoreTarget(t, now);
    return { target: t, score: base };
  });

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    // Curriculum order is the syllabus order, and ids break the final tie.
    const aC = CURRICULUM.findIndex(function (c) { return c.id === a.target.target_id; });
    const bC = CURRICULUM.findIndex(function (c) { return c.id === b.target.target_id; });
    const aIdx = aC === -1 ? 999 : aC;
    const bIdx = bC === -1 ? 999 : bC;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.target.target_id < b.target.target_id ? -1 : 1;
  });

  return scored.slice(0, Math.max(0, slots)).map(function (s) {
    return {
      id: s.target.target_id,
      label: s.target.label,
      category: s.target.category,
      status: s.target.status,
      kind: s.target.kind,
      score: s.score,
      reason: targetReason(s.target)
    };
  });
}

/* ---------------- topic ---------------- */

export function selectTopic(ownerHash, dateKey, interests) {
  const catalogue = [];
  const wanted = Array.isArray(interests) ? interests : [];
  for (const slug of wanted) {
    const found = TOPICS.find(function (t) { return t.slug === slug; });
    if (found && !catalogue.some(function (c) { return c.slug === found.slug; })) catalogue.push(found);
  }
  const list = catalogue.length ? catalogue : TOPICS;

  const dayNumber = Math.floor(dateKeyToMs(dateKey) / DAY_MS);
  const seed = hash32(String(ownerHash || ""));
  const index = Math.abs((dayNumber + seed) % list.length);
  return list[index];
}

/* ---------------- reading + speaking specs ---------------- */

function readingDifficulty(skillReading) {
  const s = clamp(Number(skillReading), 0, 100);
  if (s < 40) return "easy";
  if (s < 70) return "moderate";
  return "challenging";
}

const READING_WORDS = {
  quick: { easy: 90, moderate: 120, challenging: 150 },
  standard: { easy: 140, moderate: 190, challenging: 240 },
  full: { easy: 220, moderate: 300, challenging: 380 }
};

/* ---------------- the planner ---------------- */

/**
 * Builds today's plan.
 *
 * @param {object} input
 *   ownerHash      string, only used to spread topic rotation between learners
 *   dateKey        'YYYY-MM-DD', the learner's local day
 *   now            epoch ms (supplied, never read from the clock in here)
 *   mode           'quick' | 'standard' | 'full'
 *   profile        learner_profile row (already normalised)
 *   vocabulary     [{ id, english, hebrew, mastery, dueAt, lastPracticedAt, approval, ... }]
 *   targets        learning_target rows
 *   recentSessions session_summary rows, newest first
 *   revision       integer, bumped only by an explicit replan
 *
 * @returns a plain object ready to be persisted and serialised. No content is
 *   generated: each activity carries a `spec` describing what a future content
 *   generator should produce.
 */
export function planDay(input) {
  const mode = isMode(input.mode) ? input.mode : DEFAULT_MODE;
  const cfg = SESSION_MODES[mode];
  const now = Number(input.now);
  const dateKey = input.dateKey;
  const profile = input.profile || {};
  const vocabulary = Array.isArray(input.vocabulary) ? input.vocabulary : [];
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const sessions = Array.isArray(input.recentSessions) ? input.recentSessions : [];
  const revision = Math.max(1, Number(input.revision) || 1);

  const rationale = [];

  /* 1. Reviews that are due — the highest priority in the product spec. */
  const schedulable = vocabulary.filter(function (v) {
    return v.approval !== "rejected" && v.approval !== "pending";
  });
  const dueItems = rankDue(schedulable.filter(function (v) { return isDue(v, now) && !isNewItem(v); }), now);
  const untouched = rankDue(schedulable.filter(isNewItem), now);
  const dueCount = dueItems.length;

  const reviewPicks = dueItems.slice(0, cfg.reviewCapacity);
  if (reviewPicks.length) {
    rationale.push(
      reviewPicks.length + " word" + (reviewPicks.length === 1 ? " is" : "s are") +
      " due for review" + (dueCount > reviewPicks.length ? " (" + dueCount + " in total)" : "") + "."
    );
  }

  /* 2. New material, sized by backlog and recent performance. */
  const accuracy = recentAccuracy(sessions, "vocabulary", VOCAB_RULES.recentSessionWindow);
  const newTarget = newWordTarget({ mode: mode, dueCount: dueCount, recentVocabAccuracy: accuracy });
  for (const r of newTarget.reasons) rationale.push(r);

  const newPicks = untouched.slice(0, newTarget.count);
  const newWordsToSource = Math.max(0, newTarget.count - newPicks.length);
  if (newTarget.count > 0) {
    rationale.push("Introducing " + newTarget.count + " new word" + (newTarget.count === 1 ? "" : "s") + " today.");
  }

  /* 3. Recurring weaknesses, topped up with curriculum coverage. */
  const grammar = selectGrammarTargets(targets, cfg.grammarSlots, now);
  for (const g of grammar) rationale.push(g.reason);

  /* 4. Variety and continuity. */
  const topic = selectTopic(input.ownerHash, dateKey, safeJsonArray(profile.interests));
  rationale.push("Today's loose theme is " + topic.label + ".");

  const grammarIds = grammar.map(function (g) { return g.id; });
  const reviewIds = reviewPicks.map(function (v) { return v.id; });
  const newIds = newPicks.map(function (v) { return v.id; });
  const vocabForContent = reviewIds.concat(newIds).slice(0, 6);

  const activities = [];
  let position = 0;

  function push(type, title, minutes, objectives, spec) {
    activities.push({
      activityId: dateKey + "-" + type,
      position: position++,
      type: type,
      title: title,
      estimatedMinutes: minutes,
      status: "pending",
      objectives: objectives,
      spec: spec,
      completedAt: null
    });
  }

  const writingDue = isWritingDue(sessions, profile, now, dateKey);
  const includeWriting = cfg.includeWritingWhenDue && writingDue;

  /* Writing is periodic, not daily. When it does come up on a Standard day it
     must not push the day past ~30 minutes, so Reading and Speaking each give
     up a few minutes rather than the total growing. */
  const trim = includeWriting && mode === "standard" ? 3 : 0;

  for (const moduleName of cfg.modules) {
    if (moduleName === "vocabulary") {
      push(
        "vocabulary",
        "Vocabulary",
        cfg.minutes.vocabulary,
        grammarIds.slice(0, 0).concat([]),   // vocabulary objectives are words, not grammar targets
        {
          reviewItemIds: reviewIds,
          newItemIds: newIds,
          newWordsRequested: newTarget.count,
          newWordsToSource: newWordsToSource,
          dueTotal: dueCount,
          topic: topic.slug,
          contentNeeded: newWordsToSource > 0 ? "new_words" : "none"
        }
      );
    } else if (moduleName === "sentence_practice") {
      push(
        "sentence_practice",
        "Sentence Practice",
        cfg.minutes.sentence_practice,
        grammarIds,
        {
          grammarTargets: grammar.map(function (g) {
            return { id: g.id, label: g.label, status: g.status, kind: g.kind };
          }),
          itemCount: mode === "quick" ? 4 : mode === "full" ? 10 : 6,
          topic: topic.slug,
          vocabularyItemIds: vocabForContent.slice(0, 3),
          contentNeeded: "sentences"
        }
      );
    } else if (moduleName === "reading") {
      const difficulty = readingDifficulty(profile.skill_reading);
      push(
        "reading",
        "Reading",
        Math.max(3, cfg.minutes.reading - trim),
        grammarIds.slice(0, 1),
        {
          topic: topic.slug,
          topicLabel: topic.label,
          difficulty: difficulty,
          targetWordCount: READING_WORDS[mode][difficulty],
          comprehensionQuestions: mode === "quick" ? 2 : mode === "full" ? 5 : 3,
          seedVocabularyItemIds: vocabForContent,
          grammarTargets: grammarIds,
          contentNeeded: "passage"
        }
      );
    } else if (moduleName === "speaking") {
      push(
        "speaking",
        "Speaking",
        Math.max(3, cfg.minutes.speaking - trim),
        grammarIds.slice(0, 1),
        {
          topic: topic.slug,
          topicLabel: topic.label,
          // Objectives, not requirements: these shape the conversation the way
          // a good tutor steers a chat, and must never make it stilted.
          grammarOpportunities: grammarIds.slice(0, 1),
          vocabularyOpportunities: vocabForContent.slice(0, 3),
          turns: mode === "quick" ? 4 : mode === "full" ? 12 : 8,
          objectivesAreOpportunities: true,
          contentNeeded: "conversation_prompt"
        }
      );
    }
  }

  if (includeWriting) {
    rationale.push("Writing is due again (it is a periodic activity, not a daily one).");
    push(
      "writing",
      "Writing",
      cfg.minutes.writing,
      grammarIds.slice(0, 1),
      {
        topic: topic.slug,
        topicLabel: topic.label,
        targetWordCount: mode === "full" ? 140 : 90,
        grammarTargets: grammarIds.slice(0, 1),
        vocabularyItemIds: vocabForContent.slice(0, 4),
        contentNeeded: "writing_prompt"
      }
    );
  }

  const totalMinutes = activities.reduce(function (sum, a) { return sum + a.estimatedMinutes; }, 0);

  return {
    planId: dateKey + "-" + mode + "-r" + revision,
    planDate: dateKey,
    revision: revision,
    mode: mode,
    modeLabel: cfg.label,
    topic: topic.slug,
    topicLabel: topic.label,
    totalMinutes: totalMinutes,
    generator: GENERATOR,
    provisionalProfile: !!profile.provisional,
    rationale: rationale,
    activities: activities
  };
}

/* ---------------- evidence -> state ---------------- */

/** Mean accuracy over the most recent N sessions of one activity type.
    Returns null when there is no evidence, which the callers treat as
    "no opinion" rather than "bad". */
export function recentAccuracy(sessions, activityType, windowSize) {
  const relevant = (sessions || [])
    .filter(function (s) { return s.activity_type === activityType && Number(s.itemsAttempted) > 0; })
    .slice(0, windowSize);
  if (!relevant.length) return null;
  let attempted = 0;
  let correct = 0;
  for (const s of relevant) {
    attempted += Number(s.itemsAttempted) || 0;
    correct += Number(s.itemsCorrect) || 0;
  }
  if (attempted <= 0) return null;
  return (correct / attempted) * 100;
}

export const WRITING_PERIOD_DAYS = 7;

/** Writing is due a week after the last writing session — or, for a learner
    who has never written, a week after the profile was created, so day one is
    the four core modules and not five. */
export function isWritingDue(sessions, profile, now, dateKey) {
  const last = (sessions || []).find(function (s) { return s.activity_type === "writing"; });
  const since = last ? Number(last.createdAt) : Number(profile && profile.createdAt);
  if (!Number.isFinite(since)) return false;
  const dayMs = dateKeyToMs(dateKey);
  const reference = Number.isFinite(dayMs) ? dayMs : now;
  return daysBetween(reference, since) >= WRITING_PERIOD_DAYS;
}

/**
 * Applies one activity's evidence to one learning target and returns the new
 * state. Pure: the caller persists whatever comes back.
 *
 * The counters decay rather than reset — a success chips one off recentErrors
 * and vice versa — so a target reflects the recent trend instead of a lifetime
 * tally, without needing timestamps per event.
 */
export function applyTargetEvidence(target, evidence) {
  const now = Number(evidence.now);
  const dayKey = evidence.dayKey || "";
  const errors = Math.max(0, Number(evidence.errors) || 0);
  const successes = Math.max(0, Number(evidence.successes) || 0);

  const next = Object.assign({}, target);
  next.errors = (Number(target.errors) || 0) + errors;
  next.successes = (Number(target.successes) || 0) + successes;

  let recentErrors = Math.max(0, Number(target.recentErrors) || 0);
  let recentSuccesses = Math.max(0, Number(target.recentSuccesses) || 0);

  if (errors > 0) {
    recentErrors += errors;
    recentSuccesses = Math.max(0, recentSuccesses - errors);
    next.lastErrorAt = now;
    if (dayKey && dayKey !== target.lastErrorDay) {
      next.errorDayCount = (Number(target.errorDayCount) || 0) + 1;
      next.lastErrorDay = dayKey;
    }
  }
  if (successes > 0) {
    recentSuccesses += successes;
    recentErrors = Math.max(0, recentErrors - successes);
    next.lastSuccessAt = now;
  }

  next.recentErrors = recentErrors;
  next.recentSuccesses = recentSuccesses;
  next.lastPracticedAt = now;
  next.confidence = Math.round(
    (100 * (next.successes + 1)) / (next.successes + next.errors + 2)
  );
  next.status = nextTargetStatus(target.status || "observed", next, now);
  next.updatedAt = now;
  return next;
}

/** The lifecycle transitions, in one readable place. */
export function nextTargetStatus(current, t, now) {
  const recentErrors = Number(t.recentErrors) || 0;
  const recentSuccesses = Number(t.recentSuccesses) || 0;
  const quietDays = daysBetween(now, Number(t.lastErrorAt));

  if (current === "improving" || current === "monitoring") {
    // A fixed issue that comes back matters again immediately.
    if (recentErrors >= TARGET_RULES.relapseErrors) return "needs_work";
  }

  if (current === "observed") {
    // Both conditions, not either: repeated AND spread over more than one day.
    if (recentErrors >= TARGET_RULES.promoteErrors &&
        (Number(t.errorDayCount) || 0) >= TARGET_RULES.promoteErrorDays) {
      return "needs_work";
    }
    return "observed";
  }

  if (current === "needs_work") {
    if (recentSuccesses >= TARGET_RULES.improvingSuccesses && recentSuccesses > recentErrors) {
      return "improving";
    }
    return "needs_work";
  }

  if (current === "improving") {
    if (recentSuccesses >= TARGET_RULES.monitoringSuccesses &&
        quietDays >= TARGET_RULES.monitoringQuietDays) {
      return "monitoring";
    }
    return "improving";
  }

  return current === "monitoring" ? "monitoring" : "observed";
}

/**
 * Moves one vocabulary item along the mastery ladder and re-schedules it.
 * A success climbs one rung, a failure drops one — never all the way down,
 * because forgetting a strong word once is not the same as never knowing it.
 */
export function applyVocabularyEvidence(state, evidence) {
  const now = Number(evidence.now);
  const correct = !!evidence.correct;
  const idx = Math.max(0, MASTERY_LADDER.indexOf(state.mastery || "new"));
  const nextIdx = clamp(correct ? idx + 1 : idx - 1, 0, MASTERY_LADDER.length - 1);
  const mastery = MASTERY_LADDER[nextIdx];
  const intervalDays = MASTERY_INTERVAL_DAYS[mastery];

  return Object.assign({}, state, {
    mastery: mastery,
    successes: (Number(state.successes) || 0) + (correct ? 1 : 0),
    failures: (Number(state.failures) || 0) + (correct ? 0 : 1),
    streak: correct ? (Number(state.streak) || 0) + 1 : 0,
    intervalDays: intervalDays,
    lastPracticedAt: now,
    dueAt: now + intervalDays * DAY_MS,
    updatedAt: now
  });
}

/* ---------------- misc ---------------- */

export function safeJsonArray(text) {
  if (Array.isArray(text)) return text;
  try {
    const v = JSON.parse(String(text || "[]"));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

export function safeJsonObject(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  try {
    const v = JSON.parse(String(text || "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}
