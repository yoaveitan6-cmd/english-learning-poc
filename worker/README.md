# Sync POC backend — Cloudflare Workers + D1

Backend for the cross-device storage test only. No AI, no login, no vocabulary
system. One table, three endpoints.

Everything below fits inside Cloudflare's **free plan**. No credit card is required.

---

## What is and is not in this repository

| File | In public git? | Why |
|---|---|---|
| `src/worker.js` | yes | No secrets in it. |
| `schema.sql` | yes | Table definition only. |
| `wrangler.toml.example` | yes | Template with placeholders. |
| `wrangler.toml` | **no — gitignored** | Holds your D1 `database_id`. |
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
structured learning feedback. It is a pure request/response proxy — **nothing is written
to D1**.

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
resulting `owner_hash` is deliberately unused here, because this endpoint stores nothing.

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

## Tests

```bash
npm test
```

Runs `node --test` over `worker/test/`. Gemini is stubbed with fake HTTP responses and D1
with an in-memory double, so the suite needs no network, no Cloudflare login and no real
key. It covers the sync CRUD behaviour, CORS, input validation, structured-output parsing,
malformed model output, 429 / upstream failures, timeouts, and the assertion that no
response ever contains the API key, the pepper or the sync key.

## Local development (optional)

```bash
# .dev.vars is gitignored. Use a throwaway value here — NOT the deployed
# SYNC_PEPPER, which should never be written to disk.
printf 'SYNC_PEPPER = "%s"\n' "$(openssl rand -base64 32)" > worker/.dev.vars
npx wrangler dev --config=./wrangler.toml
```

A local `.dev.vars` pepper produces different `owner_hash` values than production,
so local runs use a separate, empty dataset. That is intended.
