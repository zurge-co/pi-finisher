import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_VERIFY_ROUNDS,
	buildReport,
	freshGoalRun,
	goalDriverDone,
	goalKey,
	judgeCase,
	nextGoalDriverStep,
	resumeOrStart,
} from "../extensions/zense-harness/index.ts";

const passing = (id) => judgeCase(id, "$ npm test\nexit code 0\nVERDICT: PASS");
const failing = (id, cmd = "npm test") => judgeCase(id, `$ ${cmd}\nexit code 1\nVERDICT: FAIL`);
const unproven = (id) => judgeCase(id, "I am fairly sure this works.\nVERDICT: PASS");
const report = (...cases) => buildReport(cases);

const runToEnd = (state, reports) => {
	const steps = [];
	let cur = state;
	for (const r of reports) {
		const step = nextGoalDriverStep(cur, r);
		steps.push(step);
		cur = step.state;
	}
	return { steps, state: cur };
};

test("every case proven ends the run on the first round, and further steps cannot restart it", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), report(passing("c1"), passing("c2")));
	assert.equal(step.action, "finish");
	assert.equal(step.state.outcome, "verified");
	assert.equal(goalDriverDone(step.state), true);
	assert.equal(step.round, 1);
	assert.match(step.text, /goal reached: ship it/);
	assert.match(step.text, /report this once and stop/);
});

test("a failing case produces exactly one fix instruction naming that case, never a question", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), report(passing("c1"), failing("c2")));
	assert.equal(step.action, "fix");
	assert.equal(step.round, 1);
	assert.match(step.text, /c2 \(FAIL\)/);
	assert.doesNotMatch(step.text, /c1 \(FAIL\)/);
	assert.match(step.text, /the driver, not the human, decides/);
	assert.equal(goalDriverDone(step.state), false);
});

test("a claim with no executed evidence is never treated as progress", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), report(unproven("c1")));
	assert.equal(step.action, "fix");
	assert.equal(step.report.unverified.includes("c1"), true);
	assert.match(step.text, /UNVERIFIED/);
});

test("identical evidence stops the run instead of burning rounds, and says why", () => {
	const r = report(failing("c1"));
	const first = nextGoalDriverStep(freshGoalRun("ship it"), r);
	const second = nextGoalDriverStep(first.state, r);
	assert.equal(first.action, "fix");
	assert.equal(second.action, "stop");
	assert.equal(second.state.outcome, "stopped");
	assert.equal(goalDriverDone(second.state), true);
	assert.match(second.text, /stopped: the same evidence came back again/);
	assert.match(second.text, /do not keep spinning/);
});

test("the run is bounded: after the rounds run out it stops even with fresh evidence each time", () => {
	const reports = Array.from({ length: MAX_VERIFY_ROUNDS + 1 }, (_, i) => report(failing("c1", `npm test -- --round=${i}`)));
	const { steps, state } = runToEnd(freshGoalRun("ship it"), reports);
	assert.equal(steps.filter((s) => s.action === "fix").length, MAX_VERIFY_ROUNDS);
	const last = steps[steps.length - 1];
	assert.equal(last.action, "stop");
	assert.equal(state.outcome, "exhausted");
	assert.match(last.text, /verify round\(s\) used up/);
	assert.ok(steps.every((s) => s.round <= MAX_VERIFY_ROUNDS));
});

test("the same goal resumes its counter, a new goal starts from round zero", () => {
	const started = resumeOrStart(undefined, "ship it", 1);
	const afterFix = nextGoalDriverStep(started, report(failing("c1"))).state;
	const resumed = resumeOrStart(afterFix, "  SHIP IT ", 2);
	assert.equal(resumed, afterFix, "the same goal must keep its rounds");
	assert.equal(resumed.loop.round, 1);
	const other = resumeOrStart(afterFix, "something else", 3);
	assert.equal(other.loop.round, 0);
	assert.equal(other.confirmedAt, 3);
	const done = nextGoalDriverStep(freshGoalRun("ship it"), report(passing("c1"))).state;
	assert.notEqual(resumeOrStart(done, "ship it", 4), done, "a finished goal must not be silently reopened");
	assert.equal(goalKey(" Ship  It "), "ship it");
});

test("the finished report carries every case with its own evidence", () => {
	const { steps } = runToEnd(freshGoalRun("g"), Array.from({ length: MAX_VERIFY_ROUNDS + 1 }, (_, i) => report(failing("c1", `npm test -- --r${i}`))));
	const stop = steps[steps.length - 1];
	assert.match(stop.text, /c1 FAIL/);
	assert.match(stop.text, new RegExp(`\\$ npm test -- --r${MAX_VERIFY_ROUNDS} → exit 1`));
	assert.match(stop.text, /goal not proven: g/);
});

test("a fix round keeps the same goal alive, so the driver — not the call site — owns the loop", () => {
	const started = freshGoalRun("ship it", 10);
	const fix = nextGoalDriverStep(started, report(failing("c1")));
	const again = resumeOrStart(fix.state, "ship it", 11);
	assert.equal(again, fix.state);
	assert.equal(again.loop.round, 1);
	assert.deepEqual(again.loop.fingerprints.length, 1);
	const finish = nextGoalDriverStep(fix.state, report(passing("c1")));
	assert.equal(finish.action, "finish");
	assert.equal(finish.state.outcome, "verified");
	assert.equal(resumeOrStart(finish.state, "ship it", 12).loop.round, 0, "after a run closes, the same goal starts a fresh count");
});
