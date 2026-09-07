-- ---------------------------------------------------------------------------
-- Migration 0002 — learning state + deterministic planning engine.
--
-- ADDITIVE ONLY. This file contains no DROP, no DELETE, no ALTER and no
-- re-CREATE of anything that already exists. Every statement is
-- CREATE ... IF NOT EXISTS, so applying it twice is a no-op.
--
-- The live `vocabulary` table from schema.sql (migration 0001) is NOT touched.
-- Per-word learning state lives in the separate `vocabulary_state` table below,
-- joined on (owner_hash, id). A vocabulary row with no state row is simply a
-- word that has never been practised, which is exactly what a learner's
-- pre-existing words are.
--
-- Conventions carried over from 0001:
--   owner_hash  = HMAC-SHA256(SYNC_PEPPER, syncKey), lowercase hex. The raw
--                 sync key is never stored.
--   timestamps  = epoch milliseconds (INTEGER).
--   date keys   = 'YYYY-MM-DD' in the learner's local day (TEXT), so "today"
--                 means the same thing on a Mac and an iPhone in Israel.
--   JSON blobs  = TEXT holding a compact JSON array/object. D1 is not asked to
--                 query inside them; the Worker parses them.
-- ---------------------------------------------------------------------------


-- A. Learner profile -------------------------------------------------------
-- One row per sync identity. Created provisionally on first contact: we have
-- not built Initial Assessment yet, so `provisional = 1` and `level_band =
-- 'unknown'` state honestly that nothing has been measured. Skill estimates
-- are 0-100 internal numbers, deliberately NOT a CEFR label.
CREATE TABLE IF NOT EXISTS learner_profile (
  owner_hash              TEXT    PRIMARY KEY,
  provisional             INTEGER NOT NULL DEFAULT 1,             -- 1 until assessment supplies evidence
  assessment_status       TEXT    NOT NULL DEFAULT 'not_started', -- not_started | in_progress | complete
  level_band              TEXT    NOT NULL DEFAULT 'unknown',     -- unknown | foundation | developing | independent | advanced
  skill_vocabulary        INTEGER NOT NULL DEFAULT 50,            -- 0-100
  skill_grammar           INTEGER NOT NULL DEFAULT 50,
  skill_reading           INTEGER NOT NULL DEFAULT 50,
  skill_listening         INTEGER NOT NULL DEFAULT 50,
  skill_speaking          INTEGER NOT NULL DEFAULT 50,
  skill_writing           INTEGER NOT NULL DEFAULT 50,
  preferred_mode          TEXT    NOT NULL DEFAULT 'standard',    -- quick | standard | full
  preferred_minutes       INTEGER NOT NULL DEFAULT 30,
  interests               TEXT    NOT NULL DEFAULT '[]',          -- JSON array of topic slugs
  timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,             -- last offset the client reported
  createdAt               INTEGER NOT NULL,
  updatedAt               INTEGER NOT NULL
);


-- B. Vocabulary learning state --------------------------------------------
-- Extension of `vocabulary`, never a replacement. Existing rows keep working
-- untouched; this table adds the content and scheduling fields the learning
-- engine needs.
CREATE TABLE IF NOT EXISTS vocabulary_state (
  owner_hash      TEXT    NOT NULL,
  id              TEXT    NOT NULL,                    -- matches vocabulary.id for the same owner
  example         TEXT    NOT NULL DEFAULT '',
  source          TEXT    NOT NULL DEFAULT 'manual',   -- manual | detected | system
  approval        TEXT    NOT NULL DEFAULT 'approved', -- approved | pending | rejected
  mastery         TEXT    NOT NULL DEFAULT 'new',      -- new | learning | familiar | strong | mastered
  successes       INTEGER NOT NULL DEFAULT 0,
  failures        INTEGER NOT NULL DEFAULT 0,
  streak          INTEGER NOT NULL DEFAULT 0,          -- consecutive successes; resets on a failure
  intervalDays    INTEGER NOT NULL DEFAULT 0,          -- current spacing; 0 = not yet scheduled
  lastPracticedAt INTEGER,                             -- NULL = never practised
  dueAt           INTEGER,                             -- NULL = due as soon as it is picked up
  createdAt       INTEGER NOT NULL,
  updatedAt       INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, id)
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_state_due
  ON vocabulary_state (owner_hash, dueAt);


-- C. Learning targets / recurring mistakes ---------------------------------
-- A target is a thing worth practising: "Past Simple", "Articles", "Word
-- Order". `status` is the lifecycle. `recentErrors` / `recentSuccesses` are
-- decaying counters, not lifetime totals, so an old weakness that has been
-- fixed stops dominating the plan. `errorDayCount` is why one isolated slip
-- cannot become a recurring weakness: promotion needs errors on more than one
-- day, not three errors in one unlucky sentence.
CREATE TABLE IF NOT EXISTS learning_target (
  owner_hash      TEXT    NOT NULL,
  target_id       TEXT    NOT NULL,                    -- stable slug, e.g. 'past_simple'
  label           TEXT    NOT NULL,                    -- display label, e.g. 'Past Simple'
  category        TEXT    NOT NULL DEFAULT 'grammar',  -- grammar | vocabulary | usage
  status          TEXT    NOT NULL DEFAULT 'observed', -- observed | needs_work | improving | monitoring
  errors          INTEGER NOT NULL DEFAULT 0,          -- lifetime
  successes       INTEGER NOT NULL DEFAULT 0,          -- lifetime
  recentErrors    INTEGER NOT NULL DEFAULT 0,          -- decaying
  recentSuccesses INTEGER NOT NULL DEFAULT 0,          -- decaying
  errorDayCount   INTEGER NOT NULL DEFAULT 0,          -- distinct local days an error was seen
  lastErrorDay    TEXT    NOT NULL DEFAULT '',         -- 'YYYY-MM-DD' of the most recent error
  confidence      INTEGER NOT NULL DEFAULT 0,          -- 0-100, Laplace-smoothed success rate
  firstSeenAt     INTEGER NOT NULL,
  lastErrorAt     INTEGER,
  lastSuccessAt   INTEGER,
  lastPracticedAt INTEGER,
  createdAt       INTEGER NOT NULL,
  updatedAt       INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, target_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_target_status
  ON learning_target (owner_hash, status);


-- D. Session summaries / performance evidence ------------------------------
-- Deliberately summaries only. There is NO audio column and NO transcript
-- column: raw recordings and full conversations are not stored by default, and
-- adding them would be a separate, explicit decision.
CREATE TABLE IF NOT EXISTS session_summary (
  owner_hash       TEXT    NOT NULL,
  session_id       TEXT    NOT NULL,
  plan_date        TEXT    NOT NULL DEFAULT '',        -- 'YYYY-MM-DD' when tied to a daily plan
  activity_id      TEXT    NOT NULL DEFAULT '',
  activity_type    TEXT    NOT NULL,                   -- vocabulary | sentence_practice | reading | speaking | writing
  objectives       TEXT    NOT NULL DEFAULT '[]',      -- JSON array of target ids practised
  itemsAttempted   INTEGER NOT NULL DEFAULT 0,
  itemsCorrect     INTEGER NOT NULL DEFAULT 0,
  accuracy         INTEGER NOT NULL DEFAULT 0,         -- 0-100, derived
  durationSeconds  INTEGER NOT NULL DEFAULT 0,
  errorEvidence    TEXT    NOT NULL DEFAULT '[]',      -- JSON array of target ids
  strengthEvidence TEXT    NOT NULL DEFAULT '[]',      -- JSON array of target ids
  summary          TEXT    NOT NULL DEFAULT '',        -- short optional human-readable note
  createdAt        INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_summary_recent
  ON session_summary (owner_hash, createdAt DESC);


-- E. Daily plans -----------------------------------------------------------
-- One plan per (owner, local date). The primary key is what makes today's plan
-- stable: reopening the app, refreshing, or switching device finds the same
-- row instead of generating a new plan. `revision` only moves when the learner
-- explicitly asks to replan or changes session mode.
CREATE TABLE IF NOT EXISTS daily_plan (
  owner_hash   TEXT    NOT NULL,
  plan_date    TEXT    NOT NULL,                       -- 'YYYY-MM-DD' local day
  plan_id      TEXT    NOT NULL,                       -- deterministic, not random
  revision     INTEGER NOT NULL DEFAULT 1,
  mode         TEXT    NOT NULL,                       -- quick | standard | full
  topic        TEXT    NOT NULL DEFAULT '',            -- slug
  topicLabel   TEXT    NOT NULL DEFAULT '',            -- display label
  totalMinutes INTEGER NOT NULL,
  rationale    TEXT    NOT NULL DEFAULT '[]',          -- JSON array of plain-language reasons
  generator    TEXT    NOT NULL,                       -- e.g. 'deterministic-v1' — never an AI model id
  createdAt    INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, plan_date)
);

-- Activity completion lives here, separate from the plan row, so marking one
-- activity complete never rebuilds the other, unfinished activities.
CREATE TABLE IF NOT EXISTS daily_plan_activity (
  owner_hash       TEXT    NOT NULL,
  plan_date        TEXT    NOT NULL,
  activity_id      TEXT    NOT NULL,                   -- stable within the plan
  position         INTEGER NOT NULL,
  type             TEXT    NOT NULL,                   -- vocabulary | sentence_practice | reading | speaking | writing
  title            TEXT    NOT NULL,
  estimatedMinutes INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending | complete | skipped
  objectives       TEXT    NOT NULL DEFAULT '[]',      -- JSON array of learning target ids
  spec             TEXT    NOT NULL DEFAULT '{}',      -- JSON metadata for the future content generator
  completedAt      INTEGER,
  createdAt        INTEGER NOT NULL,
  updatedAt        INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, plan_date, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_activity_order
  ON daily_plan_activity (owner_hash, plan_date, position);


-- F. AI usage accounting ---------------------------------------------------
-- Internal counters only: how many Gemini calls this identity made, on which
-- day, for what purpose. This is NOT a quota implementation and NOT billing —
-- Google's real limits are not modelled or guessed here. It exists so future
-- batching and usage visibility have something to read.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  owner_hash TEXT    NOT NULL,
  usage_date TEXT    NOT NULL,                         -- 'YYYY-MM-DD' UTC
  purpose    TEXT    NOT NULL,                         -- e.g. 'correct'
  model      TEXT    NOT NULL DEFAULT '',
  calls      INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  updatedAt  INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, usage_date, purpose, model)
);
