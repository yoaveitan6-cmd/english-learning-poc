# Backend — Cloudflare Workers + D1

Three stages live in this one Worker:

1. **Sync POC** — cross-device vocabulary storage (`/vocabulary`).
2. **AI correction POC** — one sentence to Gemini, structured feedback back (`/ai/correct`).
3. **Learning engine** — the learner profile, recurring-mistake tracking and
   Today's Plan (`/learner`, `/daily-plan`, `/learning-targets`).

Stage 3 makes **no AI calls at all**. Application logic decides *what* the
learner should practise; Gemini's later job is to generate *content* for the
objectives that logic already chose.

Everything below fits inside Cloudflare's **free plan**. No credit card is required.

---

## What is and is not in this repository

| File | In public git? | Why |
|---|---|---|
| `src/worker.js` | yes | No secrets in it. |
| `schema.sql` | yes | Table definition only. |
| `wrangler.toml.example` | yes | Template with placeholders. |
| `migrations/*.sql` | yes | Additive table definitions only. |
| `src/planner.js` | yes | Pure planning logic, no I/O and no secrets. |
| `wrangler.toml` | **no — gitignored** | Holds your D1 `database_id`. |
| your Cloudflare account ID | **no — never in a tracked file** | Passed as `CLOUDFLARE_ACCOUNT_ID` at the command line. |
| `SYNC_PEPPER` | **no — never on disk** | Stored as a Cloudflare Worker secret. |
| your sync key | **no — never leaves your browsers** | Typed by you, kept in `localStorage`. |

---

## One-time setup

Run these from the repository root.

### 1. Install wrangler

```bash
npm install --save-dev wrangler
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

Opens a browser. Sign up / sign in with the free plan. Do not add a payment method.

### 3. Create the D1 database

```bash
npx wrangler d1 create english_poc
```

Copy the `database_id` UUID it prints.

### 4. Create your local wrangler.toml

```bash
cp worker/wrangler.toml.example worker/wrangler.toml
```

Open `worker/wrangler.toml` and paste the `database_id` from step 3.
Check that `ALLOWED_ORIGINS` contains your GitHub Pages origin, with no trailing slash.

### 5. Create the table

```bash
npx wrangler d1 execute english_poc --remote --file=./schema.sql --config=./wrangler.toml
```

(Run this from inside `worker/`, or adjust the paths.)

### 6. Set the server-side pepper secret

Generate a random value and store it in Cloudflare — not in this repo:

```bash
openssl rand -base64 32
```

```bash
npx wrangler secret put SYNC_PEPPER --config=./wrangler.toml
```

Paste the generated value when prompted. **Set this once and never change it** —
changing it changes every `owner_hash`, which makes existing rows unreachable.

### 7. Deploy

```bash
npx wrangler deploy --config=./wrangler.toml
```

It prints a URL like `https://english-sync.<your-subdomain>.workers.dev`.
That URL is what you paste into the app's "Worker URL" field.

### 8. Check it is alive

```bash
curl https://english-sync.yoaveitan-english.workers.dev/health
```

Expect `"dbBound": true` and `"pepperConfigured": true`.

**Deployed URL:** `https://english-sync.yoaveitan-english.workers.dev`
This is public configuration and is hard-coded as the default in `index.html`.
It grants no access on its own — every `/vocabulary` request still requires the
private sync key, which never leaves your browsers.

Setup steps 1-7 above are already done. Re-run them only if you rebuild from scratch.
Do not re-run `wrangler secret put SYNC_PEPPER`: changing the pepper changes every
`owner_hash` and makes existing rows unreachable.

---

## API

Auth on every `/vocabulary` request: header `X-Sync-Key: <your long key>` (min 20 chars).
The Worker computes `owner_hash = HMAC-SHA256(SYNC_PEPPER, syncKey)` and stores only that.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/health` | — | status, no auth needed |
| `GET` | `/vocabulary` | — | `{ records: [...], count, serverTime }` |
| `POST` | `/vocabulary` | `{ id?, english, hebrew?, createdAt?, updatedAt? }` | `{ record, applied, reason }` |
| `DELETE` | `/vocabulary/:id` | — | `{ id, deleted, serverTime }` |
| `POST` | `/ai/correct` | `{ sentence }` | `{ model, feedback, serverTime }` |
| `GET` | `/learner` | — | `{ profile, createdNow, stats }` — creates a provisional profile on first contact |
| `PATCH` | `/learner` | `{ preferredMode?, skills?, interests?, levelBand?, assessmentStatus?, timezoneOffsetMinutes? }` | `{ profile }` |
| `GET` | `/daily-plan` | `?date=&tz=` | `{ date, plan, exists }` — read only, never creates |
| `POST` | `/daily-plan` | `{ mode?, date?, timezoneOffsetMinutes?, replan? }` | `{ date, plan, created, reason, carriedOverCompletions }` |
| `POST` | `/daily-plan/activity/:id/complete` | `{ status?, itemsAttempted?, itemsCorrect?, errors?, successes?, correctItemIds?, incorrectItemIds?, summary? }` | `{ plan, targets }` |
| `GET` | `/learning-targets` | — | `{ targets, lifecycle }` |
| `POST` | `/learning-targets/evidence` | `{ errors?: [], successes?: [], date? }` | `{ targets }` |
| `GET` | `/learning-config` | — | the planner's own rules, read-only |
| `GET` | `/ai/usage` | — | `{ usage, totalCalls }` internal accounting |

Every route above uses the same `X-Sync-Key` header. There is no second auth
system, and no route accepts an `owner_hash` from the client.

`POST` upserts exactly one row. If `id` is omitted the Worker generates a UUID.
An update is skipped when its `updatedAt` is older than the stored row's
(`applied: false`, `reason: "skipped_stale_updatedAt"`). There is no endpoint that
replaces or clears the whole collection, so one device can never wipe another's records.

`DELETE` is idempotent — deleting a missing row returns `deleted: 0`, not an error.

---

## Security notes for this POC

* The sync key is a bearer secret. Anyone who has it can read and write your words.
  Use the app's **Generate** button (256 bits) rather than inventing one.
* The raw key is never written to D1 and never logged.
* `SYNC_PEPPER` means that even someone who obtains a dump of the D1 table cannot
  brute-force your sync key offline.
* `ALLOWED_ORIGINS` restricts which websites a browser will let call this Worker.
* This is deliberately not a login system. It is the smallest thing that keeps a
  reader of the public repository from reaching your data.

---

## AI correction endpoint (stage 2)

`POST /ai/correct` sends one English sentence to the Gemini Developer API and returns
structured learning feedback. The sentence, the model's answer and the API key are
**never stored**; the only thing written to D1 is an anonymous per-day call counter
(see *AI usage accounting* below).

```
browser  ── X-Sync-Key ──>  Worker  ── x-goog-api-key ──>  Gemini generateContent
                                  <── validated JSON ──
```

Request:

```json
{ "sentence": "Yesterday I go to the store." }
```

Response (`200`):

```json
{
  "model": "gemini-3.8-flash",
  "feedback": {
    "original": "...",
    "corrected": "...",
    "isCorrect": false,
    "errorTypes": ["Past Simple"],
    "explanationHe": "...",
    "naturalAlternatives": { "everyday": "...", "neutral": "...", "formal": "..." },
    "followUpExercise": { "instructionHe": "...", "question": "..." }
  }
}
```

### Why the same X-Sync-Key

The frontend is public. Without auth, any visitor could read the URL out of the page
source and spend the Gemini free-tier quota. `/ai/correct` therefore reuses
`authenticate()` unchanged — no second credential and no second auth system. The
resulting `owner_hash` is used for one thing only: attributing the call counter.

### Model and cost posture

* Model: `gemini-3.8-flash` (override with a `GEMINI_MODEL` var if ever needed).
* Plain `generateContent` text generation with `responseSchema` structured output.
* **No** grounding, Google Search, Maps, URL context, code execution, or file tools —
  nothing that would leave the free tier or require billing.
* `temperature` 0.2 and a fixed schema, so feedback stays consistent between runs.
* 20 s timeout via `AbortController`; the request is cancelled rather than left hanging.

### Failure handling

| Situation | Status | `error` |
|---|---|---|
| missing / short `X-Sync-Key` | 401 | `missing_sync_key`, `sync_key_too_short` |
| empty, non-string or over-long `sentence` | 400 | `validation_failed` |
| Gemini quota exhausted | 429 | `ai_rate_limited` |
| Gemini model not found | 502 | `ai_model_unavailable` |
| Gemini rejected the credentials | 502 | `ai_not_authorized` |
| Gemini 5xx / unreadable body | 502 | `ai_upstream_error` |
| model output not valid JSON or missing fields | 502 | `ai_bad_output` |
| answer cut off | 502 | `ai_output_truncated` |
| timeout / unreachable | 504 | `ai_timeout`, `ai_unreachable` |

The upstream body is never forwarded. Only a curated message plus Google's short status
code is returned, and every AI error object is passed through a redaction step that
replaces any occurrence of `GEMINI_API_KEY` or `SYNC_PEPPER` before it is serialised.

### Setting the key

```bash
npx wrangler secret put GEMINI_API_KEY --config=./wrangler.toml
```

Already done for this deployment. `GET /health` reports `"geminiConfigured": true` without
revealing the value.

---

## Learning engine (stage 3)

The first real product slice: persistent learner state plus a deterministic
planner that answers *"given what this learner knows, struggles with, practised
recently, and how long they have today, what should today contain?"*

### Why the planner is not an AI call

Gemini does **not** decide the plan. Application code does. That keeps learning
behaviour stable between days, keeps the reasoning explainable (every plan ships
its own `rationale`), and spends no free-tier quota on a decision ordinary code
makes better. Gemini's later job is to generate *content* for objectives the
planner has already chosen.

`src/planner.js` enforces this structurally: it performs no I/O at all. No
`fetch`, no D1, no `Date.now()`, no `Math.random()`. Every input is an argument,
so the same learner state on the same day always produces the same plan — which
the test suite asserts, including a test that fails if any network call happens
during planning.

### Session modes

| Mode | Budget | Modules |
|---|---|---|
| Quick | ~13 min | Vocabulary, Sentence Practice, Speaking |
| Standard | 30 min | Vocabulary, Sentence Practice, Reading, Speaking |
| Full | ~52 min | the four above, at longer durations |

Listening is folded into Reading and Speaking rather than being a fifth
mandatory module. Writing is periodic, not daily: it joins the plan when the
learner has not written for 7 days, and on a Standard day Reading and Speaking
each give up 3 minutes so the day stays near 30. Reading is left out of Quick
because a passage plus comprehension needs a contiguous block, and a
three-minute version is worse than none.

### Planning priorities

1. Reviews that are due
2. Recurring weaknesses (learning targets)
3. A small amount of new material
4. Variety and topic continuity

### New-word target

Base **5 per Standard day** (×0.6 Quick, ×1.4 Full), then adjusted:

| Condition | Effect |
|---|---|
| 8+ words due | ×0.7 |
| 15+ words due | ×0.4 |
| 25+ words due | ×0 — clear the backlog first |
| recent vocabulary accuracy < 60% | ×0.6 |
| accuracy > 85% **and** ≤5 due | ×1.4 |

Clamped to **0–8**, so the target can never run away.

### Grammar / sentence practice

Learner targets and a coverage curriculum are merged into **one** ranked list,
then the top 1 (Quick) or 2 (Standard/Full) are taken:

```
score = statusWeight                 (needs_work 100, improving 55, observed 40, monitoring 25)
      + min(recentErrors, 5) × 8
      − min(recentSuccesses, 5) × 4
      + 15 if an error in the last 7 days, else 7 if in the last 21
      + min(days since last practised, 14) × 1.5
```

A never-practised curriculum item scores a flat **30**. That single ranking is
what gives weaknesses priority *and* guarantees coverage: two active weaknesses
claim both slots, one weakness gets a curriculum item alongside it, and a
learner with no error history practises pure curriculum. Ties break on
curriculum order and then on target id, so the result is fully deterministic.

### Recurring mistake lifecycle

```
observed ──(3+ recent errors on 2+ distinct days)──> needs_work
needs_work ──(3+ recent successes, more than errors)──> improving
improving ──(6+ recent successes, no error for 14 days)──> monitoring
improving | monitoring ──(2+ recent errors)──> needs_work
```

The `2+ distinct days` condition is the important one: **one isolated mistake
stays merely `observed`**, and so do three mistakes inside a single unlucky
sentence. Counters decay rather than reset — a success chips one off
`recentErrors` and vice versa — so a target reflects the recent trend instead of
a lifetime tally.

Vocabulary mastery is a five-rung ladder (`new → learning → familiar → strong →
mastered`) with 0/1/3/7/21-day spacing. A wrong answer drops **one** rung, not
all the way down: forgetting a strong word once is not the same as never having
known it.

### Plan stability

`POST /daily-plan` is idempotent. A refresh, a relaunch, or the learner's other
device all POST the same thing and all get the stored plan back with
`created: false`. A plan is rebuilt only for an explicit reason, and the
response names it:

| `reason` | When |
|---|---|
| `new_plan` | no plan existed for that date |
| `existing_plan_returned` | the stored plan was returned unchanged |
| `session_mode_changed` | the learner asked for a different mode |
| `explicit_replan` | `{ "replan": true }` |

The date changing naturally creates a new plan, because plans are keyed by
`(owner_hash, plan_date)`. Completion updates only the one activity row; the
other unfinished activities are never re-scored or reordered.

`GET /daily-plan` never creates anything, so simply opening the app cannot be
what decides the day.

### Completion survives a session-mode change

Changing mode says how much **time** the learner has today. It is not a
retraction of work they have already done, so a rebuild never turns a finished
activity back into an unfinished one.

This needs no extra table. `activity_id` is already `<dateKey>-<type>`, which is
stable semantic identity within a learning day, and `session_summary` — written
on every completion and never deleted by a replan — already is the day's
completion ledger. A rebuild reads that ledger and restores `complete` on any
matching activity, reporting how many it kept as `carriedOverCompletions`.

| Scenario | Result |
|---|---|
| Standard (Vocabulary done) → Quick | Vocabulary still complete, `1/3` |
| Quick → Standard | completions kept, Reading newly offered as pending |
| Standard (Reading done) → Quick | Reading is **not** in Quick's denominator (`x/3`), but appears in `plan.completedOutsidePlan` |
| …→ Standard again | Reading comes back already complete |

An activity the current mode excludes is deliberately kept out of `progress`: a
short day must not be judged against activities it does not ask for. It is
surfaced in `completedOutsidePlan` instead, so the preservation is visible in
the API and in the UI rather than silently held in the database.

`skipped` is treated differently on purpose. A skip is a decision about the
current plan rather than completed work, so it is carried forward only while the
new mode still contains that activity, and it never counts toward progress.

Replanning has never touched `session_summary`, `learning_target` or
`vocabulary_state` — learning evidence always survived. It was only the plan
row's status that was being lost.

### Provisional learners

Initial Assessment does not exist yet. A new learner therefore gets a profile
that says so honestly: `provisional: true`, `levelBand: "unknown"`, neutral 50s
for every skill. No CEFR label is invented, and the flag is visible in the API
and in the UI.

### AI usage accounting

`ai_usage_daily` counts Gemini calls per identity, per UTC day, per purpose.
This is **not** a quota implementation — Google's real limits are not modelled,
guessed, or enforced, and there is no billing. It exists so future batching and
usage visibility have something to read. Recording failures are swallowed: the
accounting can never break the feature it measures.

---

## Database migrations

`schema.sql` is migration 0001 and is already live. Everything after it lives in
`migrations/`, applied in filename order.

**Every migration in this project must be additive.** No `DROP`, no
`DELETE FROM`, no `ALTER TABLE`, no `TRUNCATE`, and every `CREATE` guarded with
`IF NOT EXISTS` so re-applying is a no-op. A test asserts all of this against the
migration files themselves, so a destructive migration fails CI rather than
production.

Migration 0002 adds seven tables and touches none of the existing ones. Note in
particular that per-word learning state lives in a **separate**
`vocabulary_state` table joined on `(owner_hash, id)`, rather than adding columns
to the live `vocabulary` table. A word with no state row is simply one that has
never been practised — which is exactly what every pre-existing word is, so no
data migration was needed at all.

Preview what a migration would do, then apply it:

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npx wrangler d1 execute english_poc --local --config=./wrangler.toml --file=./migrations/0002_learning_engine.sql
```

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npx wrangler d1 execute english_poc --remote --config=./wrangler.toml --file=./migrations/0002_learning_engine.sql
```

---

## Tests

```bash
npm test
```

Runs `node --test` over `worker/test/`. Gemini is stubbed with fake HTTP
responses, so the suite needs no network, no Cloudflare login and no real key.

D1 is a **real SQLite database** (`node:sqlite`) built from `schema.sql` plus
every file in `migrations/`. That means a mistake in a migration, a missing
column, or SQL that does not mean what it looks like fails the tests rather than
production.

Coverage: sync CRUD, CORS, input validation, structured-output parsing,
malformed model output, 429 / upstream failures, timeouts; provisional and
existing learner state, owner isolation on every route, deterministic planning,
plan persistence and stability across requests and devices, Quick/Standard/Full
allocation, backlog and performance effects on the new-word target, recurring
weakness prioritisation, the isolated-mistake rule, completion persistence,
completion carried across every session-mode transition (including a round trip
through a mode that excludes the activity), date-boundary behaviour, migration
additivity, and the assertions that planning makes zero network calls and that
no response ever contains the API key, the pepper or the sync key.

## Local development (optional)

```bash
# .dev.vars is gitignored. Use a throwaway value here — NOT the deployed
# SYNC_PEPPER, which should never be written to disk.
printf 'SYNC_PEPPER = "%s"\n' "$(openssl rand -base64 32)" > worker/.dev.vars
npx wrangler dev --config=./wrangler.toml
```

A local `.dev.vars` pepper produces different `owner_hash` values than production,
so local runs use a separate, empty dataset. That is intended.
