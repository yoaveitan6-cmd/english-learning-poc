-- ---------------------------------------------------------------------------
-- Migration 0003 — Vocabulary MVP: real sessions, generated content, attempts.
--
-- ADDITIVE ONLY. No DROP, no DELETE, no ALTER, no re-CREATE of anything that
-- already exists. Every statement is CREATE ... IF NOT EXISTS, so applying it
-- twice is a no-op and applying it to the live database cannot lose a row.
--
-- What it deliberately does NOT do:
--   * It does not touch `vocabulary` (migration 0001). The learner's real saved
--     words keep their exact rows.
--   * It does not touch `vocabulary_state` (migration 0002). That table already
--     carries source / approval / mastery / scheduling, which is precisely what
--     this slice needs, so the three vocabulary sources and the pending-approval
--     flow are expressed in the columns that already exist:
--
--       source   = 'manual' | 'system' | 'detected'
--       approval = 'approved' | 'pending' | 'rejected'
--
--     A suggested word is a normal vocabulary row whose state says
--     source='detected', approval='pending'. planner.js already refuses to
--     schedule anything pending or rejected, so approval is enforced by code
--     that was written and tested before this slice existed.
--
-- The four new tables below add only what genuinely had nowhere to live:
-- richer teaching content per word, the day's materialised session, the
-- exercises in it, and the learner's answers.
--
-- Conventions carried over from 0001/0002:
--   owner_hash  = HMAC-SHA256(SYNC_PEPPER, syncKey), lowercase hex.
--   timestamps  = epoch milliseconds (INTEGER).
--   date keys   = 'YYYY-MM-DD' in the learner's local day (TEXT).
--   JSON blobs  = TEXT holding compact JSON. D1 never queries inside them.
-- ---------------------------------------------------------------------------


-- A. Teaching detail for one word -----------------------------------------
-- `vocabulary` holds english + hebrew, and `vocabulary_state` holds the
-- example sentence and the scheduling. Everything else a learner needs in
-- order to actually LEARN a word — what part of speech it is, what it means in
-- English, how formal it is, why it is worth knowing — lives here.
--
-- A word with no row here is simply a word nobody enriched, which is exactly
-- the state of every word the learner saved before this slice. Nothing is
-- backfilled and nothing breaks.
CREATE TABLE IF NOT EXISTS vocabulary_detail (
  owner_hash       TEXT    NOT NULL,
  id               TEXT    NOT NULL,                  -- matches vocabulary.id for the same owner
  partOfSpeech     TEXT    NOT NULL DEFAULT '',       -- 'phrasal verb', 'noun', 'expression', ...
  definitionEn     TEXT    NOT NULL DEFAULT '',       -- one short English definition
  register         TEXT    NOT NULL DEFAULT 'neutral',-- everyday | neutral | formal | mixed
  usefulnessNoteHe TEXT    NOT NULL DEFAULT '',       -- one line in Hebrew: why this is worth knowing
  topic            TEXT    NOT NULL DEFAULT '',       -- topic slug the word was chosen for
  origin           TEXT    NOT NULL DEFAULT '',       -- which module suggested it: speaking | writing | reading | ''
  contextNote      TEXT    NOT NULL DEFAULT '',       -- where a detected word was noticed
  generatedBy      TEXT    NOT NULL DEFAULT '',       -- '' | 'gemini' | 'learner'
  batchDate        TEXT    NOT NULL DEFAULT '',       -- 'YYYY-MM-DD' of the system batch it came from
  createdAt        INTEGER NOT NULL,
  updatedAt        INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, id)
);


-- B. One vocabulary session ------------------------------------------------
-- The session is what makes "open it again and get the same lesson" true, and
-- it is the reason the system vocabulary batch is generated exactly once.
--
-- session_key is deterministic, never random:
--   '<YYYY-MM-DD>'            the daily session driven by Today's Plan
--   '<YYYY-MM-DD>:<mode>'     a focused practice run started from the Library
--
-- So a refresh, a relaunch, or the learner's other device all resolve to the
-- same primary key and therefore the same stored session — no second Gemini
-- call, no different batch of words.
CREATE TABLE IF NOT EXISTS vocab_session (
  owner_hash        TEXT    NOT NULL,
  session_key       TEXT    NOT NULL,
  plan_date         TEXT    NOT NULL,                    -- learner's local day
  activity_id       TEXT    NOT NULL DEFAULT '',         -- Today's Plan activity, '' for focused runs
  practiceMode      TEXT    NOT NULL DEFAULT 'smart_mix',-- smart_mix | en_he | he_en | fill_blank | meaning_context | write_sentence
  reviewItemIds     TEXT    NOT NULL DEFAULT '[]',       -- JSON array of vocabulary ids
  newItemIds        TEXT    NOT NULL DEFAULT '[]',       -- JSON array of vocabulary ids
  newWordsRequested INTEGER NOT NULL DEFAULT 0,          -- what the planner asked for
  newWordsGenerated INTEGER NOT NULL DEFAULT 0,          -- what Gemini actually supplied
  totalExercises    INTEGER NOT NULL DEFAULT 0,
  requiredExercises INTEGER NOT NULL DEFAULT 0,          -- the visible completion rule
  topic             TEXT    NOT NULL DEFAULT '',
  status            TEXT    NOT NULL DEFAULT 'active',   -- active | complete
  aiState           TEXT    NOT NULL DEFAULT 'none',     -- none | generated | degraded
  aiNote            TEXT    NOT NULL DEFAULT '',         -- learner-facing reason when AI was unavailable
  completedAt       INTEGER,
  createdAt         INTEGER NOT NULL,
  updatedAt         INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key)
);

CREATE INDEX IF NOT EXISTS idx_vocab_session_date
  ON vocab_session (owner_hash, plan_date);


-- C. The exercises in a session -------------------------------------------
-- Persisted, not recomputed. Deterministic exercises could be rebuilt on the
-- fly, but the AI-written ones cannot be — storing all of them in one place
-- means one rule ("read the stored session") rather than two code paths that
-- can disagree, and it is what guarantees a reload spends no AI quota.
--
-- `prompt` and `answer` are JSON because their shape differs per kind. The
-- answer is deliberately kept server-side; it is never sent with the question.
CREATE TABLE IF NOT EXISTS vocab_exercise (
  owner_hash  TEXT    NOT NULL,
  session_key TEXT    NOT NULL,
  exercise_id TEXT    NOT NULL,                       -- deterministic '<session_key>#<n>'
  position    INTEGER NOT NULL,
  item_id     TEXT    NOT NULL,                       -- vocabulary.id being practised
  kind        TEXT    NOT NULL,                       -- en_he | he_en | fill_blank | meaning_context | write_sentence
  contentFrom TEXT    NOT NULL DEFAULT 'local',       -- local | gemini
  evaluation  TEXT    NOT NULL DEFAULT 'deterministic', -- deterministic | ai
  prompt      TEXT    NOT NULL DEFAULT '{}',          -- JSON shown to the learner
  answer      TEXT    NOT NULL DEFAULT '{}',          -- JSON kept server-side
  createdAt   INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_vocab_exercise_order
  ON vocab_exercise (owner_hash, session_key, position);


-- D. The learner's answers -------------------------------------------------
-- One row per exercise, upserted, so answering the same exercise twice
-- replaces the attempt instead of double-counting it. This is the evidence the
-- completion rule reads and the scheduler acts on.
--
-- `learnerAnswer` holds what the learner typed. That is their own work, kept so
-- the session summary and the feedback survive a refresh; it is never sent
-- anywhere except back to them.
CREATE TABLE IF NOT EXISTS vocab_attempt (
  owner_hash    TEXT    NOT NULL,
  session_key   TEXT    NOT NULL,
  exercise_id   TEXT    NOT NULL,
  item_id       TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  correct       INTEGER NOT NULL DEFAULT 0,           -- 1 | 0
  learnerAnswer TEXT    NOT NULL DEFAULT '',
  feedback      TEXT    NOT NULL DEFAULT '{}',        -- JSON returned to the learner
  evaluatedBy   TEXT    NOT NULL DEFAULT 'deterministic', -- deterministic | ai | ai_unavailable
  attemptedAt   INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, session_key, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_vocab_attempt_session
  ON vocab_attempt (owner_hash, session_key);
