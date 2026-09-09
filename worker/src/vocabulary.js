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

/* ---------------- finding a phrase inside a sentence ---------------- */

/**
 * Slot words a dictionary entry uses to mark where an object goes.
 * "keep someone in the loop" is ONE expression with a slot in it, not four
 * words to be matched literally — no real sentence contains "someone".
 */
const PLACEHOLDER_WORDS = new Set([
  "someone", "somebody", "something", "oneself", "sb", "sth", "one",
  "someone's", "somebody's", "something's", "one's", "sb's", "sth's"
]);

/**
 * Forms of `be`. These carry grammar, not vocabulary: in "be strapped for
 * cash" the thing worth learning is "strapped for cash", and the copula turns
 * up as am/is/are/was/were or as a contraction glued to the subject. So `be`
 * is matched — otherwise the phrase would not be found at all — but it is
 * never blanked, because "I___ a bit ___" is not a question anyone can read.
 */
const BE_WORDS = new Set(["be", "am", "is", "are", "was", "were", "been", "being"]);

/**
 * Irregular past and participle forms for the verbs that actually head English
 * phrasal verbs and expressions.
 *
 * Suffix rules alone find "figured out" but not "kept me in the loop" or "took
 * it for granted" — and irregular verbs head a large share of exactly the
 * expressions this product is told to teach. A fixed lookup is not a parser
 * and never guesses: a verb absent from this table simply falls back to the
 * suffix rule, which is what happened to every verb before it existed.
 */
const IRREGULAR_HEADS = {
  be: ["was", "were", "been", "being", "am", "is", "are"],
  blow: ["blew", "blown"],
  break: ["broke", "broken"],
  bring: ["brought"],
  build: ["built"],
  buy: ["bought"],
  catch: ["caught"],
  come: ["came"],
  cut: ["cut"],
  do: ["did", "done", "does"],
  draw: ["drew", "drawn"],
  drive: ["drove", "driven"],
  fall: ["fell", "fallen"],
  feel: ["felt"],
  find: ["found"],
  get: ["got", "gotten"],
  give: ["gave", "given"],
  go: ["went", "gone", "goes"],
  grow: ["grew", "grown"],
  hang: ["hung"],
  have: ["had", "has"],
  hit: ["hit"],
  hold: ["held"],
  keep: ["kept"],
  know: ["knew", "known"],
  lay: ["laid"],
  lead: ["led"],
  leave: ["left"],
  let: ["let"],
  lose: ["lost"],
  make: ["made"],
  meet: ["met"],
  pay: ["paid"],
  put: ["put"],
  read: ["read"],
  ride: ["rode", "ridden"],
  run: ["ran"],
  say: ["said"],
  see: ["saw", "seen"],
  sell: ["sold"],
  send: ["sent"],
  set: ["set"],
  shut: ["shut"],
  sit: ["sat"],
  speak: ["spoke", "spoken"],
  spend: ["spent"],
  stand: ["stood"],
  take: ["took", "taken"],
  teach: ["taught"],
  tell: ["told"],
  think: ["thought"],
  throw: ["threw", "thrown"],
  wear: ["wore", "worn"],
  win: ["won"],
  write: ["wrote", "written"]
};

/** The most words that may sit inside a separated expression. Three covers
    "keep me in the loop" and "take our health for granted" without letting a
    match wander across half a sentence. */
export const MAX_GAP_WORDS = 3;

export const BLANK = "_____";

const WORD_SRC = "[\\p{L}\\p{N}'’-]+";
/* Word forms need a boundary in front; the contractions deliberately do not,
   because the apostrophe in "I'm" follows a letter. */
const BE_SRC =
  "(?:(?<![\\p{L}\\p{N}])(?:am|is|are|was|were|be|been|being)(?![\\p{L}\\p{N}])" +
  "|['’](?:m|re|s)(?![\\p{L}\\p{N}]))";

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How one word of the expression may appear. Only the head inflects — the tail
 * of an expression is fixed — and an irregular head offers its real forms
 * alongside the regular suffixes. Longest alternatives first, so "kept" is not
 * beaten to the match by a shorter partial.
 */
function headAlternation(part) {
  const esc = escapeRe(part.text);
  if (!part.inflect) return esc;
  const forms = [esc + "(?:s|es|ed|d|ing)?"];
  const irregular = IRREGULAR_HEADS[part.text];
  if (irregular) {
    for (const f of irregular) forms.push(escapeRe(f));
  }
  forms.sort(function (a, b) { return b.length - a.length; });
  return "(?:" + forms.join("|") + ")";
}

function bareWord(raw) {
  return String(raw).toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, "");
}

/**
 * Turns a stored term into the sequence this matcher works on: literal words,
 * `be`, and gaps where an object belongs.
 */
function termParts(term) {
  const words = String(term || "").trim().split(/\s+/).filter(Boolean);
  const parts = [];
  let seenAnchor = false;

  for (const raw of words) {
    const w = bareWord(raw);
    if (!w) continue;
    if (PLACEHOLDER_WORDS.has(w)) {
      // Never two gaps running, and never a leading gap: neither can anchor a
      // match to anything.
      if (parts.length && parts[parts.length - 1].type !== "gap") parts.push({ type: "gap" });
      continue;
    }
    if (!seenAnchor && BE_WORDS.has(w)) {
      parts.push({ type: "be" });
      seenAnchor = true;
      continue;
    }
    // Only the head inflects — "figure out" appears as "figured out", but the
    // tail of an expression is fixed.
    parts.push({ type: "word", text: w, inflect: !seenAnchor });
    seenAnchor = true;
  }

  while (parts.length && parts[parts.length - 1].type === "gap") parts.pop();
  return parts;
}

/**
 * The readings to try, in order, least surprising first.
 *
 *   A  contiguous — "cost of living", "figured out". This is exactly what this
 *      function matched before, so every sentence that worked still works, and
 *      still produces a single blank.
 *   B  the dictionary's own slot — "keep someone in the loop" finding
 *      "keep me in the loop".
 *   C  a slot the dictionary did not spell out — "take for granted" finding
 *      "take our health for granted", or "be strapped for cash" finding
 *      "I'm a bit strapped for cash".
 *
 * At most one gap is ever introduced, so a rendered exercise can never have
 * more than two blanks.
 */
function planVariants(parts) {
  const hasGap = parts.some(function (p) { return p.type === "gap"; });
  const anchors = parts.filter(function (p) { return p.type !== "gap"; });
  const plans = [anchors];

  if (hasGap) plans.push(parts);
  if (!hasGap && anchors.length >= 2) {
    const withGap = anchors.slice();
    withGap.splice(1, 0, { type: "gap" });
    plans.push(withGap);
  }
  return plans;
}

/* One capture group per part, so match.indices gives exact character spans and
   no index arithmetic has to be trusted. */
function compilePlan(plan) {
  let src = "";
  const groups = [];

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (p.type === "gap") {
      // Lazy, so a contiguous reading always wins over a separated one.
      src += "((?:\\s+" + WORD_SRC + "){1," + MAX_GAP_WORDS + "}?)";
      groups.push({ blank: false, kind: "gap" });
      continue;
    }
    if (i > 0) src += "\\s+";
    if (p.type === "be") {
      src += "(" + BE_SRC + ")";
      groups.push({ blank: false, kind: "be" });
    } else {
      src += "(" + headAlternation(p) + ")";
      groups.push({ blank: true, kind: "word" });
    }
  }

  const lead = plan[0] && plan[0].type === "be" ? "" : "(?<![\\p{L}\\p{N}])";
  return { re: new RegExp(lead + src + "(?![\\p{L}\\p{N}])", "diu"), groups };
}

/* Spans separated by nothing but whitespace become one blank. */
function mergeSpans(text, spans) {
  const sorted = spans.slice().sort(function (a, b) { return a[0] - b[0]; });
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && !/\S/.test(text.slice(last[1], s[0]))) last[1] = s[1];
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * Locates a stored term inside a sentence, tolerating the three ways a real
 * example sentence legitimately differs from a dictionary headword: an
 * inflected head, an object sitting inside the expression, and a conjugated or
 * contracted `be`.
 *
 * Returns null when the term genuinely is not there. Deterministic, and no
 * model is consulted — this is string matching, not parsing.
 */
export function findTermInSentence(sentence, term) {
  const text = String(sentence || "");
  const parts = termParts(term);
  if (!text || !parts.length) return null;

  for (const plan of planVariants(parts)) {
    if (!plan.length) continue;

    let compiled;
    try {
      compiled = compilePlan(plan);
    } catch (e) {
      continue;
    }

    const m = compiled.re.exec(text);
    if (!m || !m.indices) continue;

    const blankSpans = [];
    const blankWords = [];
    const gapWords = [];
    for (let g = 0; g < compiled.groups.length; g++) {
      const span = m.indices[g + 1];
      if (!span) continue;
      const piece = text.slice(span[0], span[1]).trim();
      if (compiled.groups[g].blank) {
        blankSpans.push(span);
        if (piece) blankWords.push(piece);
      } else if (compiled.groups[g].kind === "gap" && piece) {
        gapWords.push(piece);
      }
    }
    if (!blankSpans.length) continue;

    const merged = mergeSpans(text, blankSpans);
    // Three or more blanks stops being a question and starts being a puzzle.
    if (merged.length > 2) continue;

    /* The phrase as this sentence actually writes it, measured from the first
       blanked word to the last. Deliberately not the whole match: that would
       start at the copula, and "'m a bit strapped for cash" is not an answer
       anyone would type. */
    const phrase = text.slice(merged[0][0], merged[merged.length - 1][1]).trim();

    return {
      surface: phrase,
      matchSurface: text.slice(m.indices[0][0], m.indices[0][1]).trim(),
      blankSpans: merged,
      blankWords: blankWords,
      gapWords: gapWords,
      hasBe: plan.some(function (p) { return p.type === "be"; })
    };
  }
  return null;
}

function stripPlaceholders(term) {
  return String(term || "")
    .split(/\s+/)
    .filter(function (w) { return w && !PLACEHOLDER_WORDS.has(bareWord(w)); })
    .join(" ");
}

function stripLeadingBe(term) {
  const words = String(term || "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && BE_WORDS.has(bareWord(words[0]))) return words.slice(1).join(" ");
  return "";
}

/** Distinct answers, comparing the way the marker will, keeping first spelling. */
function dedupeAnswers(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw || "").trim();
    if (!v) continue;
    const key = normalizeAnswer(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Builds a fill-in-the-blank question from a term and its example sentence.
 *
 * The strategy, chosen once and applied everywhere: blank the expression's own
 * words and leave everything else — including any object sitting inside it —
 * visible. "We often take our health for granted." becomes "We often ___ our
 * health ___.", which still reads as English, still shows what is being taken
 * for granted, and asks for exactly the vocabulary being taught. The learner
 * types one answer; the two gaps show where the expression wraps.
 *
 * `be` is matched but never blanked, so the copula stays where the grammar
 * needs it and the question is about the words worth learning.
 *
 * Returns null when the term is not in the sentence, so the caller falls back
 * to a kind that needs no example rather than showing a broken question.
 */
export function blankOutTerm(sentence, term) {
  const text = String(sentence || "");
  const found = findTermInSentence(text, term);
  if (!found) return null;

  let blanked = "";
  let cursor = 0;
  for (const span of found.blankSpans) {
    blanked += text.slice(cursor, span[0]) + BLANK;
    cursor = span[1];
  }
  blanked += text.slice(cursor);

  // A sentence with nothing left but blanks is not answerable.
  if (!/[\p{L}\p{N}]/u.test(blanked.split(BLANK).join(" "))) return null;

  const raw = String(term || "").trim();
  const blankSurface = found.blankWords.join(" ");

  /* Every form a learner could reasonably type for THIS question: the stored
     headword, the headword without its slot marker, the phrase exactly as the
     sentence inflects it, the phrase with the sentence's own object, and — for
     a `be` expression — the version without the copula, since the copula is
     still printed in the question. */
  const accepted = dedupeAnswers([
    raw,
    stripPlaceholders(raw),
    blankSurface,
    found.surface,
    stripLeadingBe(raw),
    stripLeadingBe(blankSurface)
  ]);

  return {
    blanked: blanked,
    matchedForm: blankSurface,
    surface: found.surface,
    blankCount: found.blankSpans.length,
    gapWords: found.gapWords,
    accepted: accepted,
    display: raw
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
        // Two blanks means the expression wraps around something — say so,
        // rather than leaving the learner to work out why there are two.
        instructionHe: blank.blankCount > 1
          ? "השלימו את הביטוי החסר. שימו לב: הביטוי עוטף את המילים שבאמצע."
          : "השלימו את המילה או הביטוי החסר.",
        question: blank.blanked,
        hintHe: item.hebrew || "",
        placeholder: "Fill the blank",
        blankCount: blank.blankCount
      },
      /* Several surface forms are legitimately the same answer here: the
         dictionary headword, the headword without its "someone"/"something"
         slot, the form this sentence inflects it into, and the form carrying
         this sentence's own object. `display` is the one worth teaching back,
         which is the headword — not whichever variant the example happened to
         use. Marking stays deterministic; no model judges a fill-in. */
      answer: {
        accepted: blank.accepted,
        display: blank.display,
        strategy: "phrase_blank"
      }
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
