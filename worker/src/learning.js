/**
 * Learning-state routes: the learner profile, learning targets, session
 * evidence, and Today's Plan.
 *
 * Split out from worker.js so the deterministic engine (planner.js) and its
 * persistence live next to each other, and the original sync + AI POC code
 * stays exactly as it was verified.
 *
 * Two invariants hold everywhere in this file:
 *
 *  1. Owner isolation. Every statement is filtered by owner_hash, which the
 *     caller derived from X-Sync-Key. There is no route that reads or writes
 *     across owners, and no route that accepts an owner_hash from the client.
 *
 *  2. No Gemini. Nothing in this file calls fetch(). Producing Today's Plan is
 *     pure application logic, so it costs no AI quota and behaves the same on
 *     every request.
 */

import {
  json,
  methodNotAllowed,
  missingDb,
  readJsonBody,
  readOptionalJsonBody,
  normalizeText,
  clampInt,
  isSlug
} from "./util.js";

import {
  planDay,
  SESSION_MODES,
  DEFAULT_MODE,
  isMode,
  GENERATOR,
  CURRICULUM,
  TOPICS,
  VOCAB_RULES,
  TARGET_RULES,
  applyTargetEvidence,
  applyVocabularyEvidence,
  labelForTargetId,
  targetIdFromLabel,
  msToDateKey,
  dateKeyToMs,
  safeJsonArray,
  safeJsonObject,
  DAY_MS
} from "./planner.js";

const MAX_TARGET_ID_LEN = 40;
const MAX_LABEL_LEN = 60;
const MAX_SUMMARY_LEN = 400;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_INTERESTS = 8;
const RECENT_SESSION_LIMIT = 30;
/* A client may only ask for a plan close to the server's own idea of today.
   Without this, a request could seed plans for arbitrary dates. Two days each
   way covers every real timezone plus a slow clock. */
const MAX_DATE_DRIFT_DAYS = 2;

/* ---------------- entry point ---------------- */

/**
 * Returns a Response when the path belongs to the learning engine, or null so
 * worker.js can continue to its own routes. Auth has already happened; the
 * caller passes the owner hash in.
 */
export async function routeLearning(request, env, cors, path, method, ownerHash) {
  if (!env.DB) return json(missingDb(), 500, cors);

  if (path === "/learner") {
    if (method === "GET") return getLearner(request, env, cors, ownerHash);
    if (method === "PATCH") return patchLearner(request, env, cors, ownerHash);
    return methodNotAllowed(cors, "GET, PATCH");
  }

  if (path === "/learning-targets") {
    if (method === "GET") return listTargets(request, env, cors, ownerHash);
    return methodNotAllowed(cors, "GET");
  }

  if (path === "/learning-targets/evidence") {
    if (method === "POST") return postTargetEvidence(request, env, cors, ownerHash);
    return methodNotAllowed(cors, "POST");
  }

  if (path === "/daily-plan") {
    if (method === "GET") return getDailyPlan(request, env, cors, ownerHash);
    if (method === "POST") return createDailyPlan(request, env, cors, ownerHash);
    return methodNotAllowed(cors, "GET, POST");
  }

  const completeMatch = /^\/daily-plan\/activity\/([^/]+)\/complete$/.exec(path);
  if (completeMatch) {
    if (method !== "POST") return methodNotAllowed(cors, "POST");
    let activityId;
    try {
      activityId = decodeURIComponent(completeMatch[1]);
    } catch (e) {
      return json({ error: "bad_id", message: "activityId is not valid percent-encoding" }, 400, cors);
    }
    return completeActivity(request, env, cors, ownerHash, activityId);
  }

  if (path === "/ai/usage") {
    if (method === "GET") return getAiUsage(request, env, cors, ownerHash);
    return methodNotAllowed(cors, "GET");
  }

  if (path === "/learning-config") {
    if (method !== "GET") return methodNotAllowed(cors, "GET");
    // Read-only description of the engine so the UI (and a human) can see the
    // rules it is being planned by, without shipping them twice.
    return json(
      {
        generator: GENERATOR,
        modes: Object.keys(SESSION_MODES).map(function (k) {
          const m = SESSION_MODES[k];
          return { id: m.id, label: m.label, targetMinutes: m.targetMinutes, modules: m.modules };
        }),
        vocabularyRules: VOCAB_RULES,
        targetRules: TARGET_RULES,
        curriculum: CURRICULUM,
        topics: TOPICS,
        usesAi: false
      },
      200,
      cors
    );
  }

  return null;
}

/** Paths routeLearning owns. Kept next to the router so worker.js has one
    honest question to ask before authenticating. */
export function isLearningPath(path) {
  return (
    path === "/learner" ||
    path === "/learning-targets" ||
    path === "/learning-targets/evidence" ||
    path === "/learning-config" ||
    path === "/daily-plan" ||
    path === "/ai/usage" ||
    /^\/daily-plan\/activity\/[^/]+\/complete$/.test(path)
  );
}

/* ---------------- learner profile ---------------- */

/**
 * Loads the profile, creating a provisional one on first contact.
 *
 * Initial Assessment does not exist yet, so a new learner genuinely has no
 * measured level. The row records that honestly — `provisional: 1`,
 * `level_band: 'unknown'`, neutral 50s — instead of inventing a CEFR label the
 * app would then act on as if it were true.
 */
export async function loadOrCreateProfile(env, ownerHash, now) {
  const existing = await env.DB.prepare(
    "SELECT * FROM learner_profile WHERE owner_hash = ?"
  ).bind(ownerHash).first();
  if (existing) return { profile: normalizeProfile(existing), created: false };

  await env.DB.prepare(
    "INSERT INTO learner_profile (owner_hash, createdAt, updatedAt) VALUES (?, ?, ?) " +
    "ON CONFLICT(owner_hash) DO NOTHING"
  ).bind(ownerHash, now, now).run();

  const row = await env.DB.prepare(
    "SELECT * FROM learner_profile WHERE owner_hash = ?"
  ).bind(ownerHash).first();
  return { profile: normalizeProfile(row), created: true };
}

function normalizeProfile(row) {
  if (!row) return null;
  return {
    provisional: Number(row.provisional) === 1,
    assessmentStatus: row.assessment_status,
    levelBand: row.level_band,
    skills: {
      vocabulary: Number(row.skill_vocabulary),
      grammar: Number(row.skill_grammar),
      reading: Number(row.skill_reading),
      listening: Number(row.skill_listening),
      speaking: Number(row.skill_speaking),
      writing: Number(row.skill_writing)
    },
    preferredMode: row.preferred_mode,
    preferredMinutes: Number(row.preferred_minutes),
    interests: safeJsonArray(row.interests),
    timezoneOffsetMinutes: Number(row.timezone_offset_minutes),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    // planner.js reads these raw names
    skill_reading: Number(row.skill_reading),
    createdAt_: Number(row.createdAt)
  };
}

/** The shape planner.js expects (snake_case, exactly what the row holds). */
function plannerProfile(profile) {
  return {
    provisional: profile.provisional,
    interests: profile.interests,
    skill_reading: profile.skills.reading,
    skill_vocabulary: profile.skills.vocabulary,
    skill_grammar: profile.skills.grammar,
    createdAt: profile.createdAt
  };
}

async function getLearner(request, env, cors, ownerHash) {
  const now = Date.now();
  const { profile, created } = await loadOrCreateProfile(env, ownerHash, now);

  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS words FROM vocabulary WHERE owner_hash = ?"
  ).bind(ownerHash).first();

  const targetCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM learning_target WHERE owner_hash = ? AND status = 'needs_work'"
  ).bind(ownerHash).first();

  const due = await countDue(env, ownerHash, now);

  return json(
    {
      profile: publicProfile(profile),
      createdNow: created,
      stats: {
        vocabularyCount: Number((counts && counts.words) || 0),
        vocabularyDue: due,
        needsWorkTargets: Number((targetCount && targetCount.n) || 0)
      },
      serverTime: now
    },
    200,
    cors
  );
}

function publicProfile(p) {
  return {
    provisional: p.provisional,
    assessmentStatus: p.assessmentStatus,
    levelBand: p.levelBand,
    skills: p.skills,
    preferredMode: p.preferredMode,
    preferredMinutes: p.preferredMinutes,
    interests: p.interests,
    timezoneOffsetMinutes: p.timezoneOffsetMinutes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

const SKILL_FIELDS = {
  vocabulary: "skill_vocabulary",
  grammar: "skill_grammar",
  reading: "skill_reading",
  listening: "skill_listening",
  speaking: "skill_speaking",
  writing: "skill_writing"
};

const LEVEL_BANDS = ["unknown", "foundation", "developing", "independent", "advanced"];
const ASSESSMENT_STATUSES = ["not_started", "in_progress", "complete"];

async function patchLearner(request, env, cors, ownerHash) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);
  const body = parsed.value;
  const now = Date.now();
  await loadOrCreateProfile(env, ownerHash, now);

  const sets = [];
  const args = [];

  if (body.preferredMode !== undefined) {
    if (!isMode(body.preferredMode)) {
      return json(
        {
          error: "validation_failed",
          field: "preferredMode",
          message: "preferredMode must be one of: " + Object.keys(SESSION_MODES).join(", ")
        },
        400,
        cors
      );
    }
    sets.push("preferred_mode = ?");
    args.push(body.preferredMode);
    sets.push("preferred_minutes = ?");
    args.push(SESSION_MODES[body.preferredMode].targetMinutes);
  }

  if (body.skills !== undefined) {
    if (!body.skills || typeof body.skills !== "object" || Array.isArray(body.skills)) {
      return json({ error: "validation_failed", field: "skills", message: "skills must be an object" }, 400, cors);
    }
    for (const name of Object.keys(body.skills)) {
      if (!Object.prototype.hasOwnProperty.call(SKILL_FIELDS, name)) {
        return json(
          { error: "validation_failed", field: "skills." + name, message: "unknown skill" },
          400,
          cors
        );
      }
      const raw = body.skills[name];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) {
        return json(
          { error: "validation_failed", field: "skills." + name, message: "skill must be a number 0-100" },
          400,
          cors
        );
      }
      sets.push(SKILL_FIELDS[name] + " = ?");
      args.push(clampInt(raw, 0, 100, 50));
    }
  }

  if (body.interests !== undefined) {
    if (!Array.isArray(body.interests)) {
      return json({ error: "validation_failed", field: "interests", message: "interests must be an array" }, 400, cors);
    }
    if (body.interests.length > MAX_INTERESTS) {
      return json(
        { error: "validation_failed", field: "interests", message: "at most " + MAX_INTERESTS + " interests" },
        400,
        cors
      );
    }
    const known = TOPICS.map(function (t) { return t.slug; });
    const cleaned = [];
    for (const raw of body.interests) {
      if (typeof raw !== "string" || known.indexOf(raw) === -1) {
        return json(
          {
            error: "validation_failed",
            field: "interests",
            message: "unknown topic slug",
            allowed: known
          },
          400,
          cors
        );
      }
      if (cleaned.indexOf(raw) === -1) cleaned.push(raw);
    }
    sets.push("interests = ?");
    args.push(JSON.stringify(cleaned));
  }

  if (body.levelBand !== undefined) {
    if (LEVEL_BANDS.indexOf(body.levelBand) === -1) {
      return json(
        { error: "validation_failed", field: "levelBand", message: "levelBand must be one of: " + LEVEL_BANDS.join(", ") },
        400,
        cors
      );
    }
    sets.push("level_band = ?");
    args.push(body.levelBand);
    // Naming a band is evidence; the profile stops being provisional.
    if (body.levelBand !== "unknown") {
      sets.push("provisional = 0");
    }
  }

  if (body.assessmentStatus !== undefined) {
    if (ASSESSMENT_STATUSES.indexOf(body.assessmentStatus) === -1) {
      return json(
        {
          error: "validation_failed",
          field: "assessmentStatus",
          message: "assessmentStatus must be one of: " + ASSESSMENT_STATUSES.join(", ")
        },
        400,
        cors
      );
    }
    sets.push("assessment_status = ?");
    args.push(body.assessmentStatus);
  }

  if (body.timezoneOffsetMinutes !== undefined) {
    const tz = body.timezoneOffsetMinutes;
    if (typeof tz !== "number" || !Number.isFinite(tz) || tz < -840 || tz > 840) {
      return json(
        {
          error: "validation_failed",
          field: "timezoneOffsetMinutes",
          message: "timezoneOffsetMinutes must be a number between -840 and 840"
        },
        400,
        cors
      );
    }
    sets.push("timezone_offset_minutes = ?");
    args.push(Math.round(tz));
  }

  if (!sets.length) {
    return json(
      {
        error: "validation_failed",
        message: "nothing to update",
        allowed: ["preferredMode", "skills", "interests", "levelBand", "assessmentStatus", "timezoneOffsetMinutes"]
      },
      400,
      cors
    );
  }

  sets.push("updatedAt = ?");
  args.push(now);
  args.push(ownerHash);

  await env.DB.prepare(
    "UPDATE learner_profile SET " + sets.join(", ") + " WHERE owner_hash = ?"
  ).bind(...args).run();

  const row = await env.DB.prepare("SELECT * FROM learner_profile WHERE owner_hash = ?")
    .bind(ownerHash).first();
  return json({ profile: publicProfile(normalizeProfile(row)), serverTime: now }, 200, cors);
}

/* ---------------- learning targets ---------------- */

async function loadTargets(env, ownerHash) {
  const res = await env.DB.prepare(
    "SELECT * FROM learning_target WHERE owner_hash = ? ORDER BY target_id ASC"
  ).bind(ownerHash).all();
  return res.results || [];
}

function publicTarget(row) {
  return {
    id: row.target_id,
    label: row.label,
    category: row.category,
    status: row.status,
    errors: Number(row.errors),
    successes: Number(row.successes),
    recentErrors: Number(row.recentErrors),
    recentSuccesses: Number(row.recentSuccesses),
    errorDayCount: Number(row.errorDayCount),
    confidence: Number(row.confidence),
    firstSeenAt: Number(row.firstSeenAt),
    lastErrorAt: row.lastErrorAt === null ? null : Number(row.lastErrorAt),
    lastSuccessAt: row.lastSuccessAt === null ? null : Number(row.lastSuccessAt),
    lastPracticedAt: row.lastPracticedAt === null ? null : Number(row.lastPracticedAt),
    updatedAt: Number(row.updatedAt)
  };
}

async function listTargets(request, env, cors, ownerHash) {
  const rows = await loadTargets(env, ownerHash);
  return json(
    {
      targets: rows.map(publicTarget),
      count: rows.length,
      lifecycle: {
        statuses: ["observed", "needs_work", "improving", "monitoring"],
        rules: TARGET_RULES
      },
      serverTime: Date.now()
    },
    200,
    cors
  );
}

/**
 * Records evidence against learning targets.
 *
 * `errors` and `successes` are arrays of target ids or human labels (the free
 * text /ai/correct already returns in `errorTypes` maps straight through
 * targetIdFromLabel). The lifecycle rules in planner.js decide what the new
 * status is; this function only persists the result.
 */
async function postTargetEvidence(request, env, cors, ownerHash) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);
  const body = parsed.value;
  const now = Date.now();

  const errors = normalizeEvidenceList(body.errors);
  const successes = normalizeEvidenceList(body.successes);
  if (errors.error) return json(errors.error, 400, cors);
  if (successes.error) return json(successes.error, 400, cors);
  if (!errors.ids.length && !successes.ids.length) {
    return json(
      { error: "validation_failed", message: "at least one of errors[] or successes[] must be non-empty" },
      400,
      cors
    );
  }

  const dayKey = resolveDateKey(body.date, body.timezoneOffsetMinutes, now);
  if (dayKey.error) return json(dayKey.error, 400, cors);

  const touched = await applyEvidenceToTargets(env, ownerHash, {
    errors: errors.ids,
    successes: successes.ids,
    now: now,
    dayKey: dayKey.value
  });

  return json({ targets: touched.map(publicTarget), serverTime: now }, 200, cors);
}

function normalizeEvidenceList(raw) {
  if (raw === undefined || raw === null) return { ids: [] };
  if (!Array.isArray(raw)) {
    return { error: { error: "validation_failed", message: "errors and successes must be arrays of target ids" } };
  }
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    return { error: { error: "validation_failed", message: "at most " + MAX_EVIDENCE_ITEMS + " evidence items" } };
  }
  const ids = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { error: { error: "validation_failed", message: "each evidence item must be a string" } };
    }
    const id = targetIdFromLabel(item);
    if (!isSlug(id, MAX_TARGET_ID_LEN)) {
      return {
        error: {
          error: "validation_failed",
          message: "evidence item is not a usable learning target id",
          value: normalizeText(item).slice(0, MAX_LABEL_LEN)
        }
      };
    }
    ids.push(id);
  }
  return { ids: ids };
}

/** Shared by the evidence route and by activity completion. */
async function applyEvidenceToTargets(env, ownerHash, evidence) {
  const counts = new Map();
  for (const id of evidence.errors) {
    const c = counts.get(id) || { errors: 0, successes: 0 };
    c.errors += 1;
    counts.set(id, c);
  }
  for (const id of evidence.successes) {
    const c = counts.get(id) || { errors: 0, successes: 0 };
    c.successes += 1;
    counts.set(id, c);
  }

  const out = [];
  // Sorted so a batch of evidence writes in a stable order.
  const ids = [...counts.keys()].sort();
  for (const id of ids) {
    const c = counts.get(id);
    const existing = await env.DB.prepare(
      "SELECT * FROM learning_target WHERE owner_hash = ? AND target_id = ?"
    ).bind(ownerHash, id).first();

    const base = existing || {
      target_id: id,
      label: labelForTargetId(id),
      category: (CURRICULUM.find(function (x) { return x.id === id; }) || {}).category || "grammar",
      status: "observed",
      errors: 0,
      successes: 0,
      recentErrors: 0,
      recentSuccesses: 0,
      errorDayCount: 0,
      lastErrorDay: "",
      confidence: 0,
      firstSeenAt: evidence.now,
      lastErrorAt: null,
      lastSuccessAt: null,
      lastPracticedAt: null
    };

    const next = applyTargetEvidence(base, {
      errors: c.errors,
      successes: c.successes,
      now: evidence.now,
      dayKey: evidence.dayKey
    });

    await env.DB.prepare(
      "INSERT INTO learning_target (owner_hash, target_id, label, category, status, errors, successes, " +
      "  recentErrors, recentSuccesses, errorDayCount, lastErrorDay, confidence, firstSeenAt, " +
      "  lastErrorAt, lastSuccessAt, lastPracticedAt, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(owner_hash, target_id) DO UPDATE SET " +
      "  status = excluded.status, errors = excluded.errors, successes = excluded.successes, " +
      "  recentErrors = excluded.recentErrors, recentSuccesses = excluded.recentSuccesses, " +
      "  errorDayCount = excluded.errorDayCount, lastErrorDay = excluded.lastErrorDay, " +
      "  confidence = excluded.confidence, lastErrorAt = excluded.lastErrorAt, " +
      "  lastSuccessAt = excluded.lastSuccessAt, lastPracticedAt = excluded.lastPracticedAt, " +
      "  updatedAt = excluded.updatedAt"
    ).bind(
      ownerHash,
      id,
      String(base.label || labelForTargetId(id)).slice(0, MAX_LABEL_LEN),
      base.category || "grammar",
      next.status,
      next.errors,
      next.successes,
      next.recentErrors,
      next.recentSuccesses,
      Number(next.errorDayCount) || 0,
      next.lastErrorDay || "",
      next.confidence,
      Number(base.firstSeenAt) || evidence.now,
      next.lastErrorAt === undefined ? null : next.lastErrorAt,
      next.lastSuccessAt === undefined ? null : next.lastSuccessAt,
      next.lastPracticedAt === undefined ? null : next.lastPracticedAt,
      Number(base.createdAt) || evidence.now,
      next.updatedAt
    ).run();

    const row = await env.DB.prepare(
      "SELECT * FROM learning_target WHERE owner_hash = ? AND target_id = ?"
    ).bind(ownerHash, id).first();
    if (row) out.push(row);
  }
  return out;
}

/* ---------------- vocabulary state ---------------- */

/**
 * Vocabulary joined with its learning state. A word with no state row has
 * simply never been practised, which is exactly the situation for every word
 * the learner saved before this slice existed — so it reads as `new` and due,
 * with no migration of the live table required.
 */
async function loadVocabulary(env, ownerHash) {
  const res = await env.DB.prepare(
    "SELECT v.id AS id, v.english AS english, v.hebrew AS hebrew, " +
    "       s.example AS example, s.source AS source, s.approval AS approval, " +
    "       s.mastery AS mastery, s.successes AS successes, s.failures AS failures, " +
    "       s.streak AS streak, s.intervalDays AS intervalDays, " +
    "       s.lastPracticedAt AS lastPracticedAt, s.dueAt AS dueAt " +
    "FROM vocabulary v " +
    "LEFT JOIN vocabulary_state s ON s.owner_hash = v.owner_hash AND s.id = v.id " +
    "WHERE v.owner_hash = ? ORDER BY v.id ASC"
  ).bind(ownerHash).all();

  return (res.results || []).map(function (r) {
    return {
      id: r.id,
      english: r.english,
      hebrew: r.hebrew,
      example: r.example || "",
      source: r.source || "manual",
      approval: r.approval || "approved",
      mastery: r.mastery || "new",
      successes: Number(r.successes) || 0,
      failures: Number(r.failures) || 0,
      streak: Number(r.streak) || 0,
      intervalDays: Number(r.intervalDays) || 0,
      lastPracticedAt: r.lastPracticedAt === null || r.lastPracticedAt === undefined ? null : Number(r.lastPracticedAt),
      dueAt: r.dueAt === null || r.dueAt === undefined ? null : Number(r.dueAt)
    };
  });
}

async function countDue(env, ownerHash, now) {
  const items = await loadVocabulary(env, ownerHash);
  let n = 0;
  for (const item of items) {
    if (item.approval === "rejected" || item.approval === "pending") continue;
    if (item.dueAt === null || item.dueAt <= now) n++;
  }
  return n;
}

async function loadRecentSessions(env, ownerHash) {
  const res = await env.DB.prepare(
    "SELECT * FROM session_summary WHERE owner_hash = ? ORDER BY createdAt DESC, session_id DESC LIMIT " +
    RECENT_SESSION_LIMIT
  ).bind(ownerHash).all();
  return res.results || [];
}

/* ---------------- daily plan ---------------- */

/** Validates an explicit date, or derives one from a timezone offset. */
function resolveDateKey(rawDate, rawOffset, now) {
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null && rawOffset !== "") {
    const n = typeof rawOffset === "number" ? rawOffset : parseInt(rawOffset, 10);
    if (!Number.isFinite(n) || n < -840 || n > 840) {
      return {
        error: {
          error: "validation_failed",
          field: "timezoneOffsetMinutes",
          message: "timezoneOffsetMinutes must be a number between -840 and 840"
        }
      };
    }
    offset = Math.round(n);
  }

  if (rawDate === undefined || rawDate === null || rawDate === "") {
    return { value: msToDateKey(now, offset), offset: offset };
  }
  if (typeof rawDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return {
      error: { error: "validation_failed", field: "date", message: "date must be YYYY-MM-DD" }
    };
  }
  const ms = dateKeyToMs(rawDate);
  if (!Number.isFinite(ms)) {
    return { error: { error: "validation_failed", field: "date", message: "date is not a real calendar date" } };
  }
  // Round-trip check: '2026-02-31' parses but is not that date.
  if (msToDateKey(ms, 0) !== rawDate) {
    return { error: { error: "validation_failed", field: "date", message: "date is not a real calendar date" } };
  }
  const driftDays = Math.abs(Math.round((ms - dateKeyToMs(msToDateKey(now, 0))) / DAY_MS));
  if (driftDays > MAX_DATE_DRIFT_DAYS) {
    return {
      error: {
        error: "validation_failed",
        field: "date",
        message: "date must be within " + MAX_DATE_DRIFT_DAYS + " days of the server's current date",
        serverDate: msToDateKey(now, 0)
      }
    };
  }
  return { value: rawDate, offset: offset };
}

/**
 * The day's completion ledger: which activities the learner has actually
 * finished today, regardless of which session mode was in force at the time.
 *
 * `session_summary` already is this ledger. It is written on every completion,
 * it is never deleted by a replan, and its session_id is
 * `<dateKey>:<activityId>` where activityId is `<dateKey>-<type>`. So a row is
 * keyed by (learning day, activity type) — durable, semantic identity that
 * survives the plan being rebuilt underneath it.
 *
 * Returns Map: activity_id -> { type, completedAt }.
 */
async function loadDayCompletions(env, ownerHash, dateKey) {
  const res = await env.DB.prepare(
    "SELECT activity_id, activity_type, createdAt FROM session_summary " +
    "WHERE owner_hash = ? AND plan_date = ? AND activity_id <> '' " +
    "ORDER BY activity_id ASC"
  ).bind(ownerHash, dateKey).all();

  const out = new Map();
  for (const r of res.results || []) {
    out.set(r.activity_id, { type: r.activity_type, completedAt: Number(r.createdAt) });
  }
  return out;
}

async function readStoredPlan(env, ownerHash, dateKey) {
  const plan = await env.DB.prepare(
    "SELECT * FROM daily_plan WHERE owner_hash = ? AND plan_date = ?"
  ).bind(ownerHash, dateKey).first();
  if (!plan) return null;

  const acts = await env.DB.prepare(
    "SELECT * FROM daily_plan_activity WHERE owner_hash = ? AND plan_date = ? ORDER BY position ASC, activity_id ASC"
  ).bind(ownerHash, dateKey).all();

  const activities = (acts.results || []).map(function (a) {
    return {
      activityId: a.activity_id,
      position: Number(a.position),
      type: a.type,
      title: a.title,
      estimatedMinutes: Number(a.estimatedMinutes),
      status: a.status,
      objectives: safeJsonArray(a.objectives),
      spec: safeJsonObject(a.spec),
      completedAt: a.completedAt === null || a.completedAt === undefined ? null : Number(a.completedAt)
    };
  });

  const complete = activities.filter(function (a) { return a.status === "complete"; }).length;

  // Work finished earlier today that the current session mode does not include
  // — e.g. Reading was completed on a Standard day and the learner has since
  // switched to Quick. It is deliberately NOT in `progress`: a shorter day must
  // not be judged against activities it does not ask for. Surfacing it keeps
  // the preservation visible rather than silently held in the database, and it
  // comes straight back if the learner returns to a mode that includes it.
  const present = new Set(activities.map(function (a) { return a.activityId; }));
  const ledger = await loadDayCompletions(env, ownerHash, dateKey);
  const completedOutsidePlan = [];
  for (const [activityId, info] of ledger) {
    if (present.has(activityId)) continue;
    completedOutsidePlan.push({
      activityId: activityId,
      type: info.type,
      completedAt: info.completedAt
    });
  }

  return {
    planId: plan.plan_id,
    planDate: plan.plan_date,
    revision: Number(plan.revision),
    mode: plan.mode,
    modeLabel: (SESSION_MODES[plan.mode] || {}).label || plan.mode,
    topic: plan.topic,
    topicLabel: plan.topicLabel,
    totalMinutes: Number(plan.totalMinutes),
    generator: plan.generator,
    rationale: safeJsonArray(plan.rationale),
    activities: activities,
    progress: { complete: complete, total: activities.length },
    completedOutsidePlan: completedOutsidePlan,
    createdAt: Number(plan.createdAt),
    updatedAt: Number(plan.updatedAt)
  };
}

async function getDailyPlan(request, env, cors, ownerHash) {
  const url = new URL(request.url);
  const now = Date.now();
  const resolved = resolveDateKey(
    url.searchParams.get("date"),
    url.searchParams.get("tz"),
    now
  );
  if (resolved.error) return json(resolved.error, 400, cors);

  const plan = await readStoredPlan(env, ownerHash, resolved.value);
  return json(
    { date: resolved.value, plan: plan, exists: !!plan, serverTime: now },
    200,
    cors
  );
}

/**
 * Creates today's plan, or returns the stored one unchanged.
 *
 * This is the endpoint that makes the plan stable. It is idempotent by design:
 * a refresh, an app relaunch, or the learner's other device all POST the same
 * thing and all get back the same plan, with `created: false`. A plan is only
 * ever rebuilt for an explicit reason — `replan: true`, or a session mode that
 * differs from the stored one — and the response says which reason applied.
 *
 * A rebuild changes what today ASKS for; it never withdraws credit for what
 * the learner has already done. Completion is carried across (see
 * generateAndStore), and `carriedOverCompletions` reports how much was kept.
 */
async function createDailyPlan(request, env, cors, ownerHash) {
  const parsed = await readOptionalJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);
  const body = parsed.value;
  const now = Date.now();

  if (body.mode !== undefined && body.mode !== null && !isMode(body.mode)) {
    return json(
      {
        error: "validation_failed",
        field: "mode",
        message: "mode must be one of: " + Object.keys(SESSION_MODES).join(", ")
      },
      400,
      cors
    );
  }
  if (body.replan !== undefined && typeof body.replan !== "boolean") {
    return json({ error: "validation_failed", field: "replan", message: "replan must be a boolean" }, 400, cors);
  }

  const resolved = resolveDateKey(body.date, body.timezoneOffsetMinutes, now);
  if (resolved.error) return json(resolved.error, 400, cors);
  const dateKey = resolved.value;

  const { profile } = await loadOrCreateProfile(env, ownerHash, now);
  const mode = isMode(body.mode) ? body.mode : (isMode(profile.preferredMode) ? profile.preferredMode : DEFAULT_MODE);

  const stored = await readStoredPlan(env, ownerHash, dateKey);
  if (stored) {
    const modeChanged = stored.mode !== mode;
    const explicitReplan = body.replan === true;
    if (!modeChanged && !explicitReplan) {
      return json(
        { date: dateKey, plan: stored, created: false, reason: "existing_plan_returned", serverTime: now },
        200,
        cors
      );
    }
    const reason = explicitReplan ? "explicit_replan" : "session_mode_changed";
    const fresh = await generateAndStore(env, ownerHash, profile, mode, dateKey, now, stored.revision + 1);
    return json(
      {
        date: dateKey,
        plan: fresh.plan,
        created: true,
        reason: reason,
        // How many of today's finished activities the rebuild kept credited.
        carriedOverCompletions: fresh.carriedOverCompletions,
        serverTime: now
      },
      200,
      cors
    );
  }

  const fresh = await generateAndStore(env, ownerHash, profile, mode, dateKey, now, 1);
  return json(
    {
      date: dateKey,
      plan: fresh.plan,
      created: true,
      reason: "new_plan",
      carriedOverCompletions: fresh.carriedOverCompletions,
      serverTime: now
    },
    200,
    cors
  );
}

/**
 * Runs the deterministic planner and writes the result.
 *
 * Note what is NOT here: no fetch, no Gemini, no model id. `generator` is
 * recorded on the row so it is provable after the fact that this plan was made
 * by application code.
 *
 * Returns { plan, carriedOverCompletions } — the second being how many of
 * today's already-finished activities this rebuild kept credited.
 */
async function generateAndStore(env, ownerHash, profile, mode, dateKey, now, revision) {
  const [vocabulary, targets, sessions] = [
    await loadVocabulary(env, ownerHash),
    await loadTargets(env, ownerHash),
    await loadRecentSessions(env, ownerHash)
  ];

  const plan = planDay({
    ownerHash: ownerHash,
    dateKey: dateKey,
    now: now,
    mode: mode,
    profile: plannerProfile(profile),
    vocabulary: vocabulary,
    targets: targets,
    recentSessions: sessions,
    revision: revision
  });

  /* Completion is carried across a replan.
     ----------------------------------------------------------------
     Changing session mode is a statement about how much TIME the learner has
     today, not a retraction of work they have already done. So a rebuild must
     never turn a finished activity back into an unfinished one.

     Two sources, checked in this order:

       1. The day's completion ledger (session_summary). Durable and keyed by
          (learning day, activity type), so it survives even a round trip
          through a mode that excludes the activity entirely — Standard with
          Reading done, then Quick which has no Reading, then back to Standard,
          and Reading is complete again.

       2. The rows about to be replaced. This carries `skipped` forward for
          activities the new mode still contains. A skip is a decision about
          the current plan rather than completed work, so it is deliberately
          not written to the ledger and does not survive exclusion.

     Note what is NOT touched by a replan at all: session_summary,
     learning_target and vocabulary_state. Learning evidence has always
     survived; it was only the plan row's status that was being lost. */
  const priorRows = await env.DB.prepare(
    "SELECT activity_id, status, completedAt FROM daily_plan_activity " +
    "WHERE owner_hash = ? AND plan_date = ?"
  ).bind(ownerHash, dateKey).all();

  const priorStatus = new Map();
  for (const r of priorRows.results || []) {
    priorStatus.set(r.activity_id, {
      status: r.status,
      completedAt: r.completedAt === null || r.completedAt === undefined ? null : Number(r.completedAt)
    });
  }

  const completions = await loadDayCompletions(env, ownerHash, dateKey);

  // A replan replaces this date's activities. Scoped to one owner and one
  // date, so it can never reach another day's plan or another learner's rows.
  await env.DB.prepare(
    "DELETE FROM daily_plan_activity WHERE owner_hash = ? AND plan_date = ?"
  ).bind(ownerHash, dateKey).run();

  await env.DB.prepare(
    "INSERT INTO daily_plan (owner_hash, plan_date, plan_id, revision, mode, topic, topicLabel, " +
    "  totalMinutes, rationale, generator, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(owner_hash, plan_date) DO UPDATE SET " +
    "  plan_id = excluded.plan_id, revision = excluded.revision, mode = excluded.mode, " +
    "  topic = excluded.topic, topicLabel = excluded.topicLabel, " +
    "  totalMinutes = excluded.totalMinutes, rationale = excluded.rationale, " +
    "  generator = excluded.generator, updatedAt = excluded.updatedAt"
  ).bind(
    ownerHash,
    dateKey,
    plan.planId,
    plan.revision,
    plan.mode,
    plan.topic,
    plan.topicLabel,
    plan.totalMinutes,
    JSON.stringify(plan.rationale),
    plan.generator,
    now,
    now
  ).run();

  let carriedOver = 0;
  for (const a of plan.activities) {
    let status = "pending";
    let completedAt = null;

    const done = completions.get(a.activityId);
    if (done) {
      status = "complete";
      completedAt = done.completedAt;
      carriedOver++;
    } else {
      const prior = priorStatus.get(a.activityId);
      if (prior && prior.status === "skipped") {
        status = "skipped";
      }
    }

    await env.DB.prepare(
      "INSERT INTO daily_plan_activity (owner_hash, plan_date, activity_id, position, type, title, " +
      "  estimatedMinutes, status, objectives, spec, completedAt, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      ownerHash,
      dateKey,
      a.activityId,
      a.position,
      a.type,
      a.title,
      a.estimatedMinutes,
      status,
      JSON.stringify(a.objectives),
      JSON.stringify(a.spec),
      completedAt,
      now,
      now
    ).run();
  }

  return {
    plan: await readStoredPlan(env, ownerHash, dateKey),
    carriedOverCompletions: carriedOver
  };
}

/**
 * Marks one activity complete.
 *
 * Only that activity's row is touched — the other, unfinished activities are
 * not regenerated, re-scored, or reordered. Optional evidence in the body is
 * recorded as a session summary and fed to the learning targets, which is how
 * today's work reaches tomorrow's plan.
 */
async function completeActivity(request, env, cors, ownerHash, activityId) {
  const parsed = await readOptionalJsonBody(request);
  if (parsed.error) return json(parsed.error, 400, cors);
  const body = parsed.value;
  const now = Date.now();

  if (typeof activityId !== "string" || !activityId.length || activityId.length > 80) {
    return json({ error: "bad_id", message: "activityId must be 1-80 characters" }, 400, cors);
  }

  const resolved = resolveDateKey(body.date, body.timezoneOffsetMinutes, now);
  if (resolved.error) return json(resolved.error, 400, cors);
  const dateKey = resolved.value;

  const status = body.status === undefined ? "complete" : body.status;
  if (status !== "complete" && status !== "skipped") {
    return json(
      { error: "validation_failed", field: "status", message: "status must be 'complete' or 'skipped'" },
      400,
      cors
    );
  }

  const row = await env.DB.prepare(
    "SELECT * FROM daily_plan_activity WHERE owner_hash = ? AND plan_date = ? AND activity_id = ?"
  ).bind(ownerHash, dateKey, activityId).first();

  if (!row) {
    return json(
      { error: "not_found", message: "no activity with that id in this date's plan", date: dateKey, activityId: activityId },
      404,
      cors
    );
  }

  const attempted = clampInt(body.itemsAttempted, 0, 500, 0);
  const correct = clampInt(body.itemsCorrect, 0, 500, 0);
  if (correct > attempted) {
    return json(
      { error: "validation_failed", field: "itemsCorrect", message: "itemsCorrect cannot exceed itemsAttempted" },
      400,
      cors
    );
  }
  const duration = clampInt(body.durationSeconds, 0, 6 * 60 * 60, 0);
  const summaryText = normalizeText(body.summary).slice(0, MAX_SUMMARY_LEN);

  const evErrors = normalizeEvidenceList(body.errors);
  const evSuccesses = normalizeEvidenceList(body.successes);
  if (evErrors.error) return json(evErrors.error, 400, cors);
  if (evSuccesses.error) return json(evSuccesses.error, 400, cors);

  await env.DB.prepare(
    "UPDATE daily_plan_activity SET status = ?, completedAt = ?, updatedAt = ? " +
    "WHERE owner_hash = ? AND plan_date = ? AND activity_id = ?"
  ).bind(status, status === "complete" ? now : null, now, ownerHash, dateKey, activityId).run();

  // The plan row's updatedAt moves; nothing else about the plan is rebuilt.
  await env.DB.prepare(
    "UPDATE daily_plan SET updatedAt = ? WHERE owner_hash = ? AND plan_date = ?"
  ).bind(now, ownerHash, dateKey).run();

  let touchedTargets = [];
  if (status === "complete") {
    const sessionId = dateKey + ":" + activityId;
    await env.DB.prepare(
      "INSERT INTO session_summary (owner_hash, session_id, plan_date, activity_id, activity_type, " +
      "  objectives, itemsAttempted, itemsCorrect, accuracy, durationSeconds, errorEvidence, " +
      "  strengthEvidence, summary, createdAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(owner_hash, session_id) DO UPDATE SET " +
      "  itemsAttempted = excluded.itemsAttempted, itemsCorrect = excluded.itemsCorrect, " +
      "  accuracy = excluded.accuracy, durationSeconds = excluded.durationSeconds, " +
      "  errorEvidence = excluded.errorEvidence, strengthEvidence = excluded.strengthEvidence, " +
      "  summary = excluded.summary, createdAt = excluded.createdAt"
    ).bind(
      ownerHash,
      sessionId,
      dateKey,
      activityId,
      row.type,
      row.objectives || "[]",
      attempted,
      correct,
      attempted > 0 ? Math.round((correct / attempted) * 100) : 0,
      duration,
      JSON.stringify(evErrors.ids),
      JSON.stringify(evSuccesses.ids),
      summaryText,
      now
    ).run();

    if (evErrors.ids.length || evSuccesses.ids.length) {
      touchedTargets = await applyEvidenceToTargets(env, ownerHash, {
        errors: evErrors.ids,
        successes: evSuccesses.ids,
        now: now,
        dayKey: dateKey
      });
    }

    if (row.type === "vocabulary") {
      await applyVocabularyOutcomes(env, ownerHash, row, body, now);
    }
  }

  const plan = await readStoredPlan(env, ownerHash, dateKey);
  return json(
    {
      date: dateKey,
      activityId: activityId,
      status: status,
      plan: plan,
      targets: touchedTargets.map(publicTarget),
      serverTime: now
    },
    200,
    cors
  );
}

/**
 * Advances the mastery of the words the vocabulary activity covered.
 * `correctItemIds` / `incorrectItemIds` are optional; when the client sends
 * neither, completion is recorded but no word is re-scheduled, because
 * "I finished" is not evidence about any particular word.
 */
async function applyVocabularyOutcomes(env, ownerHash, activityRow, body, now) {
  const spec = safeJsonObject(activityRow.spec);
  const known = new Set(
    []
      .concat(safeJsonArray(spec.reviewItemIds))
      .concat(safeJsonArray(spec.newItemIds))
  );

  const outcomes = new Map();
  for (const id of asIdList(body.correctItemIds)) if (known.has(id)) outcomes.set(id, true);
  for (const id of asIdList(body.incorrectItemIds)) if (known.has(id)) outcomes.set(id, false);
  if (!outcomes.size) return;

  const ids = [...outcomes.keys()].sort();
  for (const id of ids) {
    const existing = await env.DB.prepare(
      "SELECT * FROM vocabulary_state WHERE owner_hash = ? AND id = ?"
    ).bind(ownerHash, id).first();

    const base = existing || {
      mastery: "new",
      successes: 0,
      failures: 0,
      streak: 0,
      intervalDays: 0,
      example: "",
      source: "manual",
      approval: "approved",
      createdAt: now
    };
    const next = applyVocabularyEvidence(base, { correct: outcomes.get(id), now: now });

    await env.DB.prepare(
      "INSERT INTO vocabulary_state (owner_hash, id, example, source, approval, mastery, successes, " +
      "  failures, streak, intervalDays, lastPracticedAt, dueAt, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(owner_hash, id) DO UPDATE SET " +
      "  mastery = excluded.mastery, successes = excluded.successes, failures = excluded.failures, " +
      "  streak = excluded.streak, intervalDays = excluded.intervalDays, " +
      "  lastPracticedAt = excluded.lastPracticedAt, dueAt = excluded.dueAt, " +
      "  updatedAt = excluded.updatedAt"
    ).bind(
      ownerHash,
      id,
      base.example || "",
      base.source || "manual",
      base.approval || "approved",
      next.mastery,
      next.successes,
      next.failures,
      next.streak,
      next.intervalDays,
      next.lastPracticedAt,
      next.dueAt,
      Number(base.createdAt) || now,
      next.updatedAt
    ).run();
  }
}

function asIdList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw.slice(0, 100)) {
    if (typeof v === "string" && v.length > 0 && v.length <= 64) out.push(v);
  }
  return out;
}

/* ---------------- AI usage accounting ---------------- */

/**
 * Counts one Gemini call for this identity, by UTC day and purpose.
 *
 * Accounting must never be able to break the feature it is measuring, so every
 * failure here is swallowed. This is not a quota implementation: Google's real
 * limits are not modelled, guessed, or enforced. It only makes future batching
 * and usage visibility possible.
 */
export async function recordAiUsage(env, ownerHash, purpose, model, failed) {
  if (!env.DB || !ownerHash) return;
  try {
    const now = Date.now();
    const day = msToDateKey(now, 0);
    await env.DB.prepare(
      "INSERT INTO ai_usage_daily (owner_hash, usage_date, purpose, model, calls, failures, updatedAt) " +
      "VALUES (?, ?, ?, ?, 1, ?, ?) " +
      "ON CONFLICT(owner_hash, usage_date, purpose, model) DO UPDATE SET " +
      "  calls = ai_usage_daily.calls + 1, " +
      "  failures = ai_usage_daily.failures + excluded.failures, " +
      "  updatedAt = excluded.updatedAt"
    ).bind(ownerHash, day, String(purpose).slice(0, 40), String(model || "").slice(0, 60), failed ? 1 : 0, now).run();
  } catch (e) {
    // Deliberately ignored: a missing table or a write failure must not turn a
    // working AI response into an error.
  }
}

async function getAiUsage(request, env, cors, ownerHash) {
  const res = await env.DB.prepare(
    "SELECT usage_date, purpose, model, calls, failures, updatedAt FROM ai_usage_daily " +
    "WHERE owner_hash = ? ORDER BY usage_date DESC, purpose ASC LIMIT 60"
  ).bind(ownerHash).all();

  const rows = res.results || [];
  let total = 0;
  for (const r of rows) total += Number(r.calls) || 0;

  return json(
    {
      usage: rows,
      totalCalls: total,
      note: "Internal accounting only. This does not model or enforce Google's quota, and there is no billing.",
      serverTime: Date.now()
    },
    200,
    cors
  );
}
