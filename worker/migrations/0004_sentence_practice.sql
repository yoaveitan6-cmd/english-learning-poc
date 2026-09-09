-- ---------------------------------------------------------------------------
-- Migration 0004 — Sentence Practice / Grammar MVP.
--
-- ADDITIVE ONLY. No DROP, no DELETE, no ALTER, no re-CREATE of anything that
-- already exists. Every statement is CREATE ... IF NOT EXISTS, so applying it
-- twice is a no-op and applying it to the live database cannot lose a row.
--
-- Follows exactly the shape migration 0003 used for Vocabulary: one row per
-- day's materialised session, one row per exercise in it, one row per answer.
-- Nothing here touches `vocabulary`, `vocabulary_state`, `learning_target`,
-- `daily_plan` or any other existing table. Learning-target evidence from a
-- finished session is written through the existing learning_target table via
-- the same applyEvidenceToTargets() code path /learning-targets/evidence and
-- vocabulary completion already use — no second mastery system.
--
-- Conventions carried over from 0001-0003:
--   owner_hash  = HMAC-SHA256(SYNC_PEPPER, syncKey), lowercase hex.
--   timestamps  = epoch milliseconds (INTEGER).
--   date keys   = 'YYYY-MM-DD' in the learner's local day (TEXT).
--   JSON blobs  = TEXT holding compact JSON. D1 never queries inside them.
-- ---------------------------------------------------------------------------


-- A. One Sentence Practice session ------------------------------------------
-- Today's Plan builds at most one sentence_practice activity per day (this
-- MVP has no focused/library mode the way Vocabulary does — every session is
-- the one Today's Plan asked for), so session_key is simply the plan_date.
-- That is what makes "reload gets the same session" and "the Mac and the
-- iPhone see the same exercises" true: the primary key is deterministic, not
-- random, exactly like vocab_session.
CREATE TABLE IF NOT EXISTS sentence_practice_session (
  owner_hash        TEXT    NOT NULL,
  session_key       TEXT    NOT NULL,                  -- 'YYYY-MM-DD', the learner's local day
  plan_date         TEXT    NOT NULL,
  activity_id       TEXT    NOT NULL DEFAULT '',
  targets           TEXT    NOT NULL DEFAULT '[]',      -- JSON [{id,label,status,kind}] chosen by the planner
  baseExerciseCount INTEGER NOT NULL DEFAULT 0,         -- exercises shown from the start
  totalExercises    INTEGER NOT NULL DEFAULT 0,         -- base + any reinforcement activated so far
  status            TEXT    NOT NULL DEFAULT 'active',  -- active | complete
  aiState           TEXT    NOT NULL DEFAULT 'none',    -- none | generated | degraded
  aiNote            TEXT    NOT NULL DEFAULT '',
  completedAt       INTEGER,
  createdAt         INTEGER NOT NULL,
  updatedAt         INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key)
);

CREATE INDEX IF NOT EXISTS idx_sentence_practice_session_date
  ON sentence_practice_session (owner_hash, plan_date);


-- B. The exercises in a session ----------------------------------------------
-- Persisted, never recomputed — the whole point is that a refresh or a second
-- device re-reads this table rather than spending another Gemini call.
--
-- `pool` distinguishes the base exercises shown from the start from the small
-- reinforcement reserve generated in the SAME batch. A reserve row is written
-- with active=0 and a placeholder position; POST .../answer flips exactly one
-- reserve row per missed target to active=1 and gives it the next position,
-- which is what makes reinforcement need no second Gemini call.
CREATE TABLE IF NOT EXISTS sentence_practice_exercise (
  owner_hash    TEXT    NOT NULL,
  session_key   TEXT    NOT NULL,
  exercise_id   TEXT    NOT NULL,                       -- deterministic '<session_key>#<n>'
  position      INTEGER NOT NULL,                       -- order in the active list
  pool          TEXT    NOT NULL DEFAULT 'base',         -- base | reserve
  active        INTEGER NOT NULL DEFAULT 1,              -- 1 = currently part of the visible session
  target_id     TEXT    NOT NULL,
  targetLabel   TEXT    NOT NULL DEFAULT '',
  type          TEXT    NOT NULL,                        -- fill_blank | choice | correction | transformation | free_sentence
  contentFrom   TEXT    NOT NULL DEFAULT 'gemini',
  evaluation    TEXT    NOT NULL DEFAULT 'deterministic', -- deterministic | ai
  prompt        TEXT    NOT NULL DEFAULT '{}',            -- JSON shown to the learner
  answer        TEXT    NOT NULL DEFAULT '{}',            -- JSON kept server-side
  createdAt     INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_sentence_practice_exercise_order
  ON sentence_practice_exercise (owner_hash, session_key, position);


-- C. The learner's answers ---------------------------------------------------
-- One row per exercise, upserted, so answering the same exercise twice
-- replaces the attempt instead of double-counting it — the same rule
-- vocab_attempt uses, and for the same reason: this is the evidence the
-- completion rule and the learning-target evidence both read.
CREATE TABLE IF NOT EXISTS sentence_practice_attempt (
  owner_hash    TEXT    NOT NULL,
  session_key   TEXT    NOT NULL,
  exercise_id   TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  correct       INTEGER NOT NULL DEFAULT 0,              -- 1 | 0
  learnerAnswer TEXT    NOT NULL DEFAULT '',
  feedback      TEXT    NOT NULL DEFAULT '{}',            -- JSON returned to the learner
  evaluatedBy   TEXT    NOT NULL DEFAULT 'deterministic',  -- deterministic | ai | ai_unavailable
  attemptedAt   INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_sentence_practice_attempt_session
  ON sentence_practice_attempt (owner_hash, session_key);
