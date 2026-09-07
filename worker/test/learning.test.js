/**
 * End-to-end tests for the learning-engine routes, over the real Worker with a
 * real SQLite database running the real migrations.
 *
 * The properties this file exists to prove:
 *   - a learner with no assessment gets an honest provisional profile
 *   - today's plan is stable: refresh, relaunch and second device all agree
 *   - completion persists without rebuilding the rest of the plan
 *   - another sync key can reach none of it
 *   - planning makes zero network calls
 */
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { makeEnv, req, TEST_ORIGIN, TEST_SYNC_KEY, stubFetch, migrationSql } from "./helpers.js";
import { SESSION_MODES, msToDateKey, DAY_MS } from "../src/planner.js";

const OTHER_KEY = "z".repeat(40);

async function call(request, env) {
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, text, body };
}

/** Today as the server sees it, so tests never straddle a UTC midnight. */
function todayKey() {
  return msToDateKey(Date.now(), 0);
}

/** Runs the whole block with fetch fatal, so any network call fails loudly. */
async function withNoNetwork(fn) {
  const stub = stubFetch(() => {
    throw new Error("network call during planning");
  });
  try {
    return await fn(stub);
  } finally {
    stub.restore();
  }
}

/* ---------------- provisional learner ---------------- */

test("a brand-new learner gets a provisional profile, not an invented level", async () => {
  const env = makeEnv();
  const { res, body } = await call(req("GET", "/learner"), env);
  assert.equal(res.status, 200);
  assert.equal(body.profile.provisional, true);
  assert.equal(body.profile.levelBand, "unknown");
  assert.equal(body.profile.assessmentStatus, "not_started");
  assert.equal(body.createdNow, true);
  // Nothing here should look like a measured CEFR claim.
  assert.ok(!/\b[ABC][12]\b/.test(JSON.stringify(body)));
  assert.equal(body.profile.preferredMode, "standard");
});

test("an existing learner is returned, not recreated", async () => {
  const env = makeEnv();
  const first = await call(req("GET", "/learner"), env);
  await new Promise((r) => setTimeout(r, 2));
  const second = await call(req("GET", "/learner"), env);
  assert.equal(second.body.createdNow, false);
  assert.equal(second.body.profile.createdAt, first.body.profile.createdAt);
});

test("PATCH /learner updates preferences and validates input", async () => {
  const env = makeEnv();
  const ok = await call(
    req("PATCH", "/learner", { body: { preferredMode: "full", interests: ["food_cooking"] } }),
    env
  );
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.profile.preferredMode, "full");
  assert.deepEqual(ok.body.profile.interests, ["food_cooking"]);
  assert.equal(ok.body.profile.preferredMinutes, SESSION_MODES.full.targetMinutes);

  const badMode = await call(req("PATCH", "/learner", { body: { preferredMode: "marathon" } }), env);
  assert.equal(badMode.res.status, 400);
  assert.equal(badMode.body.field, "preferredMode");

  const badTopic = await call(req("PATCH", "/learner", { body: { interests: ["astrophysics"] } }), env);
  assert.equal(badTopic.res.status, 400);

  const badSkill = await call(req("PATCH", "/learner", { body: { skills: { reading: 500 } } }), env);
  assert.equal(badSkill.res.status, 400);

  const nothing = await call(req("PATCH", "/learner", { body: { nope: 1 } }), env);
  assert.equal(nothing.res.status, 400);
});

test("naming a level band clears the provisional flag", async () => {
  const env = makeEnv();
  const r = await call(req("PATCH", "/learner", { body: { levelBand: "independent" } }), env);
  assert.equal(r.body.profile.provisional, false);
  assert.equal(r.body.profile.levelBand, "independent");
});

/* ---------------- plan creation and stability ---------------- */

test("a learner with no history still gets a usable Standard starter plan", async () => {
  const env = makeEnv();
  const { res, body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  assert.equal(res.status, 200);
  assert.equal(body.created, true);
  assert.equal(body.plan.mode, "standard");
  assert.equal(body.plan.totalMinutes, 30);
  assert.deepEqual(
    body.plan.activities.map((a) => a.type),
    ["vocabulary", "sentence_practice", "reading", "speaking"]
  );
  assert.equal(body.plan.progress.complete, 0);
  assert.equal(body.plan.progress.total, 4);
  assert.ok(body.plan.rationale.length > 0);
});

test("POSTing again the same day returns the SAME stored plan, not a new one", async () => {
  const env = makeEnv();
  const first = await call(req("POST", "/daily-plan", { body: {} }), env);
  const second = await call(req("POST", "/daily-plan", { body: {} }), env);

  assert.equal(second.body.created, false);
  assert.equal(second.body.reason, "existing_plan_returned");
  assert.equal(second.body.plan.planId, first.body.plan.planId);
  assert.equal(second.body.plan.revision, 1);
  assert.deepEqual(second.body.plan.activities, first.body.plan.activities);
});

test("a refresh (GET) after creation shows the identical plan", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const reloaded = await call(req("GET", "/daily-plan"), env);
  assert.equal(reloaded.body.exists, true);
  assert.deepEqual(reloaded.body.plan.activities, created.body.plan.activities);
  assert.equal(reloaded.body.plan.planId, created.body.plan.planId);
});

test("GET before any plan exists reports no plan rather than inventing one", async () => {
  const env = makeEnv();
  const { res, body } = await call(req("GET", "/daily-plan"), env);
  assert.equal(res.status, 200);
  assert.equal(body.exists, false);
  assert.equal(body.plan, null);
});

test("a second device with the same sync key sees the same plan and progress", async () => {
  const env = makeEnv();
  const mac = await call(req("POST", "/daily-plan", { body: {} }), env);
  const activityId = mac.body.plan.activities[0].activityId;
  await call(req("POST", "/daily-plan/activity/" + activityId + "/complete", { body: {} }), env);

  // The iPhone does exactly what the Mac did: POST on open.
  const iphone = await call(req("POST", "/daily-plan", { body: {} }), env);
  assert.equal(iphone.body.created, false);
  assert.equal(iphone.body.plan.planId, mac.body.plan.planId);
  assert.equal(iphone.body.plan.progress.complete, 1);
});

test("changing session mode is an explicit reason to replan", async () => {
  const env = makeEnv();
  const standard = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);

  assert.equal(quick.body.created, true);
  assert.equal(quick.body.reason, "session_mode_changed");
  assert.equal(quick.body.plan.mode, "quick");
  assert.equal(quick.body.plan.revision, 2);
  assert.ok(quick.body.plan.totalMinutes < standard.body.plan.totalMinutes);
  assert.ok(quick.body.plan.activities.length < standard.body.plan.activities.length);

  // And a replanned day leaves no orphaned activities behind.
  const reloaded = await call(req("GET", "/daily-plan"), env);
  assert.equal(reloaded.body.plan.activities.length, quick.body.plan.activities.length);
});

test("an explicit replan request rebuilds the day", async () => {
  const env = makeEnv();
  await call(req("POST", "/daily-plan", { body: {} }), env);
  const again = await call(req("POST", "/daily-plan", { body: { replan: true } }), env);
  assert.equal(again.body.created, true);
  assert.equal(again.body.reason, "explicit_replan");
  assert.equal(again.body.plan.revision, 2);
});

test("a different date gets its own plan; today's is untouched", async () => {
  const env = makeEnv();
  const today = todayKey();
  const tomorrow = msToDateKey(Date.now() + DAY_MS, 0);

  const a = await call(req("POST", "/daily-plan", { body: { date: today } }), env);
  const b = await call(req("POST", "/daily-plan", { body: { date: tomorrow } }), env);

  assert.equal(b.body.created, true);
  assert.notEqual(b.body.plan.planId, a.body.plan.planId);

  const stillToday = await call(req("GET", "/daily-plan?date=" + today), env);
  assert.equal(stillToday.body.plan.planId, a.body.plan.planId);
});

test("a far-away or malformed date is refused", async () => {
  const env = makeEnv();
  const far = await call(req("POST", "/daily-plan", { body: { date: "2030-01-01" } }), env);
  assert.equal(far.res.status, 400);
  assert.equal(far.body.field, "date");

  const junk = await call(req("POST", "/daily-plan", { body: { date: "today" } }), env);
  assert.equal(junk.res.status, 400);

  const impossible = await call(req("GET", "/daily-plan?date=2026-02-31"), env);
  assert.equal(impossible.res.status, 400);
});

test("the stored session mode preference drives the plan when none is given", async () => {
  const env = makeEnv();
  await call(req("PATCH", "/learner", { body: { preferredMode: "full" } }), env);
  const { body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  assert.equal(body.plan.mode, "full");
  assert.ok(body.plan.totalMinutes >= 45);
});

test("an invalid mode or replan flag is refused", async () => {
  const env = makeEnv();
  const m = await call(req("POST", "/daily-plan", { body: { mode: 7 } }), env);
  assert.equal(m.res.status, 400);
  const r = await call(req("POST", "/daily-plan", { body: { replan: "yes" } }), env);
  assert.equal(r.res.status, 400);
});

/* ---------------- completion ---------------- */

test("completing one activity persists and leaves the others alone", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const before = created.body.plan.activities;
  const target = before[1];

  const done = await call(
    req("POST", "/daily-plan/activity/" + target.activityId + "/complete", { body: {} }),
    env
  );
  assert.equal(done.res.status, 200);
  assert.equal(done.body.plan.progress.complete, 1);

  const after = done.body.plan.activities;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].activityId, before[i].activityId, "activity " + i + " kept its identity");
    assert.deepEqual(after[i].spec, before[i].spec, "activity " + i + " kept its spec");
    if (after[i].activityId !== target.activityId) {
      assert.equal(after[i].status, "pending", "unfinished activities were not rebuilt");
      assert.equal(after[i].completedAt, null);
    }
  }
  const completed = after.find((a) => a.activityId === target.activityId);
  assert.equal(completed.status, "complete");
  assert.ok(completed.completedAt > 0);
});

test("completion survives a reload and a re-POST", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const id = created.body.plan.activities[0].activityId;
  await call(req("POST", "/daily-plan/activity/" + id + "/complete", { body: {} }), env);

  const reloaded = await call(req("GET", "/daily-plan"), env);
  assert.equal(reloaded.body.plan.progress.complete, 1);

  const rePost = await call(req("POST", "/daily-plan", { body: {} }), env);
  assert.equal(rePost.body.created, false);
  assert.equal(rePost.body.plan.progress.complete, 1, "re-opening must not wipe progress");
});

test("an unknown activity id is a 404, not a silent success", async () => {
  const env = makeEnv();
  await call(req("POST", "/daily-plan", { body: {} }), env);
  const { res, body } = await call(req("POST", "/daily-plan/activity/nope/complete", { body: {} }), env);
  assert.equal(res.status, 404);
  assert.equal(body.error, "not_found");
});

test("an activity can be skipped rather than completed", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const id = created.body.plan.activities[2].activityId;
  const { body } = await call(
    req("POST", "/daily-plan/activity/" + id + "/complete", { body: { status: "skipped" } }),
    env
  );
  const a = body.plan.activities.find((x) => x.activityId === id);
  assert.equal(a.status, "skipped");
  assert.equal(a.completedAt, null);
  assert.equal(body.plan.progress.complete, 0);
});

test("completion validates its own numbers", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const id = created.body.plan.activities[0].activityId;
  const bad = await call(
    req("POST", "/daily-plan/activity/" + id + "/complete", { body: { itemsAttempted: 3, itemsCorrect: 9 } }),
    env
  );
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.field, "itemsCorrect");

  const badStatus = await call(
    req("POST", "/daily-plan/activity/" + id + "/complete", { body: { status: "half" } }),
    env
  );
  assert.equal(badStatus.res.status, 400);
});

/* ---------------- completion survives a session-mode change ---------------- */

/* Product rule: changing session mode says how much TIME the learner has
   today. It is not a retraction of work they have already done. Completed
   activities must stay completed. */

/** Completes every activity of the given types in the current plan. */
async function completeTypes(env, plan, types) {
  for (const a of plan.activities) {
    if (types.indexOf(a.type) === -1) continue;
    await call(
      req("POST", "/daily-plan/activity/" + a.activityId + "/complete", { body: {} }),
      env
    );
  }
}

function statusOf(plan, type) {
  const a = (plan.activities || []).find((x) => x.type === type);
  return a ? a.status : null;
}

test("Standard -> Quick keeps the completion of activities both modes contain", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, std.body.plan, ["vocabulary"]);

  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  assert.equal(quick.body.reason, "session_mode_changed");
  assert.equal(quick.body.plan.mode, "quick");
  assert.equal(statusOf(quick.body.plan, "vocabulary"), "complete", "Vocabulary must stay complete");
  assert.equal(quick.body.carriedOverCompletions, 1);
  assert.equal(quick.body.plan.progress.complete, 1);
  assert.equal(quick.body.plan.progress.total, 3, "Quick asks for three activities");

  // The activities the learner has not done are still waiting.
  assert.equal(statusOf(quick.body.plan, "sentence_practice"), "pending");
  assert.equal(statusOf(quick.body.plan, "speaking"), "pending");
});

test("Quick -> Standard keeps completion too", async () => {
  const env = makeEnv();
  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  await completeTypes(env, quick.body.plan, ["vocabulary", "speaking"]);

  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  assert.equal(std.body.plan.mode, "standard");
  assert.equal(statusOf(std.body.plan, "vocabulary"), "complete");
  assert.equal(statusOf(std.body.plan, "speaking"), "complete");
  assert.equal(std.body.carriedOverCompletions, 2);
  assert.equal(std.body.plan.progress.complete, 2);
  assert.equal(std.body.plan.progress.total, 4);
  // Reading only exists in Standard, so it is newly on offer and unfinished.
  assert.equal(statusOf(std.body.plan, "reading"), "pending");
});

test("an activity the current mode excludes is not counted in its denominator", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, std.body.plan, ["reading"]);
  assert.equal(std.body.plan.progress.total, 4);

  // Quick has no Reading at all.
  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  assert.equal(quick.body.plan.activities.some((a) => a.type === "reading"), false);
  assert.equal(quick.body.plan.progress.total, 3, "a short day is not judged against Reading");
  assert.equal(quick.body.plan.progress.complete, 0);

  // But the day's evidence is preserved and visible, not silently dropped.
  const outside = quick.body.plan.completedOutsidePlan;
  assert.equal(outside.length, 1);
  assert.equal(outside[0].type, "reading");
  assert.ok(outside[0].completedAt > 0);
});

test("returning to a mode that contains the activity restores its completed state", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, std.body.plan, ["reading"]);

  await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  const back = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);

  assert.equal(statusOf(back.body.plan, "reading"), "complete", "Reading came back already done");
  assert.equal(back.body.plan.progress.complete, 1);
  assert.equal(back.body.plan.progress.total, 4);
  assert.deepEqual(back.body.plan.completedOutsidePlan, []);
});

test("Full -> Quick -> Full loses no completed activity evidence", async () => {
  const env = makeEnv();
  const full = await call(req("POST", "/daily-plan", { body: { mode: "full" } }), env);
  const fullTypes = full.body.plan.activities.map((a) => a.type);
  await completeTypes(env, full.body.plan, ["vocabulary", "reading", "speaking"]);
  assert.equal(full.body.plan.progress.total, fullTypes.length);

  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  // Quick contains Vocabulary and Speaking, so those stay credited; Reading is
  // excluded but preserved.
  assert.equal(statusOf(quick.body.plan, "vocabulary"), "complete");
  assert.equal(statusOf(quick.body.plan, "speaking"), "complete");
  assert.equal(quick.body.plan.completedOutsidePlan.map((x) => x.type).indexOf("reading") !== -1, true);

  const back = await call(req("POST", "/daily-plan", { body: { mode: "full" } }), env);
  for (const type of ["vocabulary", "reading", "speaking"]) {
    assert.equal(statusOf(back.body.plan, type), "complete", type + " must still be complete");
  }
  assert.equal(back.body.plan.progress.complete, 3);
  assert.deepEqual(back.body.plan.completedOutsidePlan, []);
});

test("a mode change never erases learning, session or completion evidence", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  const sentence = std.body.plan.activities.find((a) => a.type === "sentence_practice");
  await call(
    req("POST", "/daily-plan/activity/" + sentence.activityId + "/complete", {
      body: { itemsAttempted: 8, itemsCorrect: 6, errors: ["Articles"], successes: ["Past Simple"] }
    }),
    env
  );

  const targetsBefore = (await call(req("GET", "/learning-targets"), env)).body.targets;
  const sessionsBefore = env.DB.query("SELECT * FROM session_summary");

  await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  await call(req("POST", "/daily-plan", { body: { mode: "full" } }), env);

  const targetsAfter = (await call(req("GET", "/learning-targets"), env)).body.targets;
  const sessionsAfter = env.DB.query("SELECT * FROM session_summary");

  assert.deepEqual(targetsAfter, targetsBefore, "learning targets are untouched by replanning");
  assert.deepEqual(sessionsAfter, sessionsBefore, "session evidence is untouched by replanning");

  const finalPlan = (await call(req("GET", "/daily-plan"), env)).body.plan;
  assert.equal(statusOf(finalPlan, "sentence_practice"), "complete");
});

test("an explicit replan also preserves completion", async () => {
  const env = makeEnv();
  const first = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, first.body.plan, ["vocabulary", "speaking"]);

  const again = await call(req("POST", "/daily-plan", { body: { replan: true } }), env);
  assert.equal(again.body.reason, "explicit_replan");
  assert.equal(again.body.carriedOverCompletions, 2);
  assert.equal(again.body.plan.progress.complete, 2);
});

test("completion carried through a mode change survives a refresh and another device", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, std.body.plan, ["vocabulary", "reading"]);
  await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);

  // Refresh: a plain GET, which never rebuilds anything.
  const refreshed = await call(req("GET", "/daily-plan"), env);
  assert.equal(refreshed.body.plan.mode, "quick");
  assert.equal(statusOf(refreshed.body.plan, "vocabulary"), "complete");
  assert.equal(refreshed.body.plan.progress.complete, 1);
  assert.equal(refreshed.body.plan.progress.total, 3);
  assert.equal(refreshed.body.plan.completedOutsidePlan[0].type, "reading");

  // The other device opens with the same key and the same stored mode.
  const other = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  assert.equal(other.body.created, false, "no rebuild — the mode did not change");
  assert.equal(other.body.plan.progress.complete, 1);
  assert.equal(statusOf(other.body.plan, "vocabulary"), "complete");
});

test("a skipped activity stays skipped while the mode still contains it", async () => {
  const env = makeEnv();
  const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  const speaking = std.body.plan.activities.find((a) => a.type === "speaking");
  await call(
    req("POST", "/daily-plan/activity/" + speaking.activityId + "/complete", { body: { status: "skipped" } }),
    env
  );

  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  assert.equal(statusOf(quick.body.plan, "speaking"), "skipped");
  // A skip is not completed work, so it never counts toward progress.
  assert.equal(quick.body.plan.progress.complete, 0);
  assert.equal(quick.body.carriedOverCompletions, 0);
});

test("a plan with nothing done yet reports no carried-over completion", async () => {
  const env = makeEnv();
  const first = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  assert.equal(first.body.carriedOverCompletions, 0);
  assert.deepEqual(first.body.plan.completedOutsidePlan, []);

  const quick = await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
  assert.equal(quick.body.carriedOverCompletions, 0);
  assert.equal(quick.body.plan.progress.complete, 0);
});

test("carrying completion across a mode change makes no network call", async () => {
  const env = makeEnv();
  await withNoNetwork(async (stub) => {
    const std = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
    await completeTypes(env, std.body.plan, ["vocabulary", "reading"]);
    await call(req("POST", "/daily-plan", { body: { mode: "quick" } }), env);
    await call(req("POST", "/daily-plan", { body: { mode: "full" } }), env);
    await call(req("GET", "/daily-plan"), env);
    assert.equal(stub.calls.length, 0, "mode switching must not call Gemini either");
  });
});

test("another sync key's completion is never carried into my plan", async () => {
  const env = makeEnv();
  const mine = await call(req("POST", "/daily-plan", { body: { mode: "standard" } }), env);
  await completeTypes(env, mine.body.plan, ["vocabulary", "reading"]);

  // Same calendar day, so the activity ids are identical strings — only
  // owner_hash separates us.
  const theirs = await call(req("POST", "/daily-plan", { body: { mode: "standard" }, key: OTHER_KEY }), env);
  assert.equal(theirs.body.carriedOverCompletions, 0);
  assert.equal(theirs.body.plan.progress.complete, 0);
  assert.deepEqual(theirs.body.plan.completedOutsidePlan, []);

  const theirQuick = await call(req("POST", "/daily-plan", { body: { mode: "quick" }, key: OTHER_KEY }), env);
  assert.equal(theirQuick.body.plan.progress.complete, 0);
});

/* ---------------- evidence feeding tomorrow's plan ---------------- */

test("completion evidence updates learning targets", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const sentence = created.body.plan.activities.find((a) => a.type === "sentence_practice");

  const done = await call(
    req("POST", "/daily-plan/activity/" + sentence.activityId + "/complete", {
      body: { itemsAttempted: 6, itemsCorrect: 4, errors: ["Past Simple", "Past Simple"], successes: ["Articles"] }
    }),
    env
  );
  assert.equal(done.res.status, 200);
  const ids = done.body.targets.map((t) => t.id).sort();
  assert.deepEqual(ids, ["articles", "past_simple"]);

  const list = await call(req("GET", "/learning-targets"), env);
  const past = list.body.targets.find((t) => t.id === "past_simple");
  assert.equal(past.status, "observed", "two errors on one day is not yet a recurring weakness");
  assert.equal(past.recentErrors, 2);
});

test("evidence recorded on separate days promotes a target to needs_work", async () => {
  const env = makeEnv();
  const today = todayKey();
  const yesterday = msToDateKey(Date.now() - DAY_MS, 0);

  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Past Simple", "Past Simple"], date: yesterday } }), env);
  let list = await call(req("GET", "/learning-targets"), env);
  assert.equal(list.body.targets.find((t) => t.id === "past_simple").status, "observed");

  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Past Simple"], date: today } }), env);
  list = await call(req("GET", "/learning-targets"), env);
  const past = list.body.targets.find((t) => t.id === "past_simple");
  assert.equal(past.status, "needs_work");
  assert.equal(past.errorDayCount, 2);
});

test("a recurring weakness is prioritised in the next day's plan", async () => {
  const env = makeEnv();
  const today = todayKey();
  const yesterday = msToDateKey(Date.now() - DAY_MS, 0);

  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Prepositions", "Prepositions"], date: yesterday } }), env);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Prepositions"], date: today } }), env);

  const { body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  const sentence = body.plan.activities.find((a) => a.type === "sentence_practice");
  assert.equal(sentence.objectives[0], "prepositions");
  assert.match(body.plan.rationale.join(" "), /Prepositions is a recurring weakness/);
});

test("an isolated mistake does not take over the plan", async () => {
  const env = makeEnv();
  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Spelling"] } }), env);
  const { body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  const sentence = body.plan.activities.find((a) => a.type === "sentence_practice");
  assert.ok(!body.plan.rationale.join(" ").includes("recurring weakness"));
  assert.equal(sentence.objectives.length, 2);
});

test("successful evidence improves a target's state", async () => {
  const env = makeEnv();
  const today = todayKey();
  const yesterday = msToDateKey(Date.now() - DAY_MS, 0);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Articles", "Articles"], date: yesterday } }), env);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Articles"], date: today } }), env);

  await call(req("POST", "/learning-targets/evidence", { body: { successes: ["Articles", "Articles", "Articles", "Articles", "Articles", "Articles"] } }), env);
  const list = await call(req("GET", "/learning-targets"), env);
  const articles = list.body.targets.find((t) => t.id === "articles");
  assert.equal(articles.status, "improving");
  assert.ok(articles.confidence > 0);
});

test("evidence input is validated", async () => {
  const env = makeEnv();
  const empty = await call(req("POST", "/learning-targets/evidence", { body: {} }), env);
  assert.equal(empty.res.status, 400);

  const wrongType = await call(req("POST", "/learning-targets/evidence", { body: { errors: "Past Simple" } }), env);
  assert.equal(wrongType.res.status, 400);

  const junk = await call(req("POST", "/learning-targets/evidence", { body: { errors: ["!!!"] } }), env);
  assert.equal(junk.res.status, 400);

  const tooMany = await call(
    req("POST", "/learning-targets/evidence", { body: { errors: new Array(50).fill("Articles") } }),
    env
  );
  assert.equal(tooMany.res.status, 400);
});

/* ---------------- vocabulary integration ---------------- */

test("existing vocabulary rows with no learning state are treated as new and due", async () => {
  const env = makeEnv();
  // Words saved by the sync POC, before this slice existed.
  for (const w of ["apple", "harbour", "deliberate"]) {
    await call(req("POST", "/vocabulary", { body: { id: w, english: w } }), env);
  }
  const { body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  const vocab = body.plan.activities.find((a) => a.type === "vocabulary");
  assert.deepEqual(vocab.spec.newItemIds.sort(), ["apple", "deliberate", "harbour"]);
  assert.equal(vocab.spec.newWordsToSource, 2, "5 requested, 3 already saved");
});

test("a review backlog cuts the new-word target through the real API", async () => {
  const env = makeEnv();
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const id = "w" + String(i).padStart(2, "0");
    await call(req("POST", "/vocabulary", { body: { id, english: id } }), env);
    env.DB.exec(
      "INSERT INTO vocabulary_state (owner_hash, id, mastery, lastPracticedAt, dueAt, createdAt, updatedAt) " +
      "SELECT owner_hash, '" + id + "', 'learning', " + (now - 5 * DAY_MS) + ", " + (now - DAY_MS) + ", " + now + ", " + now + " " +
      "FROM vocabulary WHERE id = '" + id + "'"
    );
  }
  const { body } = await call(req("POST", "/daily-plan", { body: {} }), env);
  const vocab = body.plan.activities.find((a) => a.type === "vocabulary");
  assert.equal(vocab.spec.dueTotal, 20);
  assert.ok(vocab.spec.reviewItemIds.length > 0);
  assert.ok(vocab.spec.newWordsRequested < 5, "backlog reduced the new-word target");
  assert.match(body.plan.rationale.join(" "), /due for review/);
});

test("marking the vocabulary activity complete advances the words it covered", async () => {
  const env = makeEnv();
  await call(req("POST", "/vocabulary", { body: { id: "harbour", english: "harbour" } }), env);
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const vocab = created.body.plan.activities.find((a) => a.type === "vocabulary");

  await call(
    req("POST", "/daily-plan/activity/" + vocab.activityId + "/complete", {
      body: { itemsAttempted: 1, itemsCorrect: 1, correctItemIds: ["harbour"] }
    }),
    env
  );

  const state = env.DB.query("SELECT * FROM vocabulary_state WHERE id = 'harbour'");
  assert.equal(state.length, 1);
  assert.equal(state[0].mastery, "learning");
  assert.ok(state[0].dueAt > Date.now(), "the word was scheduled forward");
});

test("a word the learner does not own cannot be advanced through a completion", async () => {
  const env = makeEnv();
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  const vocab = created.body.plan.activities.find((a) => a.type === "vocabulary");
  await call(
    req("POST", "/daily-plan/activity/" + vocab.activityId + "/complete", {
      body: { correctItemIds: ["some-other-learners-word"] }
    }),
    env
  );
  assert.equal(env.DB.query("SELECT * FROM vocabulary_state").length, 0);
});

/* ---------------- owner isolation ---------------- */

test("another sync key cannot see the plan, targets or profile", async () => {
  const env = makeEnv();
  const mine = await call(req("POST", "/daily-plan", { body: {} }), env);
  await call(req("POST", "/learning-targets/evidence", { body: { errors: ["Articles"] } }), env);

  const theirPlan = await call(req("GET", "/daily-plan", { key: OTHER_KEY }), env);
  assert.equal(theirPlan.res.status, 200);
  assert.equal(theirPlan.body.exists, false, "another key must not see my plan");

  const theirTargets = await call(req("GET", "/learning-targets", { key: OTHER_KEY }), env);
  assert.equal(theirTargets.body.count, 0);

  const theirLearner = await call(req("GET", "/learner", { key: OTHER_KEY }), env);
  assert.equal(theirLearner.body.createdNow, true, "they get their own fresh profile");
  assert.equal(theirLearner.body.stats.vocabularyCount, 0);

  // And mine is still intact afterwards.
  const stillMine = await call(req("GET", "/daily-plan"), env);
  assert.equal(stillMine.body.plan.planId, mine.body.plan.planId);
});

test("another sync key cannot complete my activity", async () => {
  const env = makeEnv();
  const mine = await call(req("POST", "/daily-plan", { body: {} }), env);
  const id = mine.body.plan.activities[0].activityId;

  const theirs = await call(
    req("POST", "/daily-plan/activity/" + id + "/complete", { body: {}, key: OTHER_KEY }),
    env
  );
  assert.equal(theirs.res.status, 404);

  const check = await call(req("GET", "/daily-plan"), env);
  assert.equal(check.body.plan.progress.complete, 0, "my plan was not touched");
});

test("every learning route requires a sync key", async () => {
  const env = makeEnv();
  const paths = [
    ["GET", "/learner"],
    ["PATCH", "/learner"],
    ["GET", "/daily-plan"],
    ["POST", "/daily-plan"],
    ["GET", "/learning-targets"],
    ["POST", "/learning-targets/evidence"],
    ["GET", "/learning-config"],
    ["GET", "/ai/usage"],
    ["POST", "/daily-plan/activity/x/complete"]
  ];
  for (const [method, path] of paths) {
    const opts = method === "GET" ? {} : { body: {} };
    const none = await call(req(method, path, { ...opts, key: null }), env);
    assert.equal(none.res.status, 401, method + " " + path + " without a key");
    const short = await call(req(method, path, { ...opts, key: "short" }), env);
    assert.equal(short.res.status, 401, method + " " + path + " with a weak key");
  }
});

/* ---------------- no AI during planning ---------------- */

test("creating, reading and completing a plan makes ZERO network calls", async () => {
  const env = makeEnv();
  await withNoNetwork(async (stub) => {
    const created = await call(req("POST", "/daily-plan", { body: {} }), env);
    assert.equal(created.res.status, 200);
    await call(req("GET", "/daily-plan"), env);
    await call(req("GET", "/learner"), env);
    await call(req("GET", "/learning-targets"), env);
    await call(
      req("POST", "/daily-plan/activity/" + created.body.plan.activities[0].activityId + "/complete", {
        body: { itemsAttempted: 5, itemsCorrect: 5, successes: ["Articles"] }
      }),
      env
    );
    await call(req("POST", "/daily-plan", { body: { replan: true } }), env);
    assert.equal(stub.calls.length, 0, "the planner must not call Gemini");
  });
});

test("no plan mentions a model, and the generator names application code", async () => {
  const env = makeEnv();
  const { body, text } = await call(req("POST", "/daily-plan", { body: {} }), env);
  assert.equal(body.plan.generator, "deterministic-v1");
  assert.ok(!/gemini|generativelanguage|googleapis/i.test(text));
});

test("/learning-config declares the engine uses no AI and exposes its rules", async () => {
  const env = makeEnv();
  const { res, body } = await call(req("GET", "/learning-config"), env);
  assert.equal(res.status, 200);
  assert.equal(body.usesAi, false);
  assert.ok(body.modes.length === 3);
  assert.ok(body.curriculum.length > 0);
  assert.equal(body.vocabularyRules.baseNewWords, 5);
});

/* ---------------- AI usage accounting ---------------- */

test("usage accounting starts empty and is per-owner", async () => {
  const env = makeEnv();
  const mine = await call(req("GET", "/ai/usage"), env);
  assert.equal(mine.res.status, 200);
  assert.equal(mine.body.totalCalls, 0);
  assert.match(mine.body.note, /no billing/i);
});

/* ---------------- CORS + regressions ---------------- */

test("learning routes honour the same origin allowlist", async () => {
  const env = makeEnv();
  const ok = await worker.fetch(req("POST", "/daily-plan", { body: {}, origin: TEST_ORIGIN }), env);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), TEST_ORIGIN);

  const bad = await call(req("POST", "/daily-plan", { body: {}, origin: "https://evil.example" }), env);
  assert.equal(bad.res.status, 403);
  assert.equal(bad.body.error, "origin_not_allowed");
});

test("preflight for a learning route still advertises X-Sync-Key", async () => {
  const res = await worker.fetch(req("OPTIONS", "/daily-plan", { key: null, origin: TEST_ORIGIN }), makeEnv());
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-Sync-Key/);
});

test("wrong methods on learning routes are 405 with an Allow header", async () => {
  const env = makeEnv();
  const del = await worker.fetch(req("DELETE", "/daily-plan"), env);
  assert.equal(del.status, 405);
  assert.ok(del.headers.get("Allow").includes("POST"));
});

test("no learning response contains the sync key or the pepper", async () => {
  const env = makeEnv();
  const responses = [];
  const created = await call(req("POST", "/daily-plan", { body: {} }), env);
  responses.push(created.text);
  responses.push((await call(req("GET", "/learner"), env)).text);
  responses.push((await call(req("GET", "/learning-targets"), env)).text);
  responses.push((await call(req("GET", "/learning-config"), env)).text);
  responses.push((await call(req("GET", "/ai/usage"), env)).text);
  responses.push(
    (await call(req("POST", "/daily-plan/activity/" + created.body.plan.activities[0].activityId + "/complete", { body: {} }), env)).text
  );
  for (const text of responses) {
    assert.ok(!text.includes(TEST_SYNC_KEY));
    assert.ok(!text.includes(env.SYNC_PEPPER));
    assert.ok(!text.includes(env.GEMINI_API_KEY));
  }
});

test("health advertises the planner without leaking anything", async () => {
  const env = makeEnv();
  const { body, text } = await call(req("GET", "/health", { key: null }), env);
  assert.equal(body.planner.usesAi, false);
  assert.equal(body.planner.generator, "deterministic-v1");
  assert.ok(!text.includes(env.SYNC_PEPPER));
  assert.ok(!text.includes(env.GEMINI_API_KEY));
});

/* ---------------- migration safety ---------------- */

test("every migration is additive: no DROP, DELETE, ALTER or TRUNCATE", () => {
  for (const { name, sql } of migrationSql()) {
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(!/\bDROP\b/i.test(code), name + " must not DROP anything");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(code), name + " must not DELETE");
    assert.ok(!/\bALTER\s+TABLE\b/i.test(code), name + " must not ALTER an existing table");
    assert.ok(!/\bTRUNCATE\b/i.test(code), name + " must not TRUNCATE");
    // Everything it does create must tolerate being applied twice.
    const creates = code.match(/CREATE\s+(TABLE|INDEX)/gi) || [];
    const guarded = code.match(/CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/gi) || [];
    assert.equal(creates.length, guarded.length, name + " must guard every CREATE with IF NOT EXISTS");
  }
});

test("the live vocabulary table keeps its original shape", () => {
  const env = makeEnv();
  const cols = env.DB.query("PRAGMA table_info(vocabulary)").map((c) => c.name);
  assert.deepEqual(cols, ["owner_hash", "id", "english", "hebrew", "createdAt", "updatedAt"]);
});

test("the learning tables exist after the migrations", () => {
  const env = makeEnv();
  const names = env.DB
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
  for (const t of [
    "ai_usage_daily",
    "daily_plan",
    "daily_plan_activity",
    "learner_profile",
    "learning_target",
    "session_summary",
    "vocabulary",
    "vocabulary_state"
  ]) {
    assert.ok(names.includes(t), "missing table " + t);
  }
});

test("session summaries store no audio and no transcript", () => {
  const env = makeEnv();
  const cols = env.DB.query("PRAGMA table_info(session_summary)").map((c) => c.name.toLowerCase());
  for (const forbidden of ["audio", "audiourl", "recording", "transcript", "conversation"]) {
    assert.ok(!cols.includes(forbidden), "session_summary must not have a " + forbidden + " column");
  }
});
