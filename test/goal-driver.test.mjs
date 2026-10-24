import { test } from "node:test";
import assert from "node:assert/strict";

const evidence = (body) => (String(body).trim() ? `EVIDENCE:\n${body}` : "");
import { buildGoalToolText, buildReport, freshGoalRun, goalKey, judgeCase, nextGoalDriverStep, resumeOrStart } from "../extensions/finisher/index.ts";

const pass = (id) => judgeCase(id, evidence(`$ node -e "run()"\nexit code 0\nVERDICT: PASS`));
const fail = (id) => judgeCase(id, evidence(`$ node -e "run()"\nexit code 1\nVERDICT: FAIL`));
const unproven = (id) => judgeCase(id, evidence("VERDICT: UNVERIFIED — needs a human"));

test("all cases proven → finish, and the state records the verified outcome", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([pass("c1")]));
	assert.equal(step.action, "finish");
	assert.equal(step.state.outcome, "verified");
	assert.equal(step.state.doneAt !== undefined, true);
});

test("a failing case hands the plan back to the main agent instead of finishing", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([fail("c1")]));
	assert.equal(step.action, "replan");
	assert.equal(step.state.doneAt, undefined, "the run is still open");
	assert.equal(step.state.attempts.rounds, 1);
	assert.equal(step.state.phases.length, 1, "a failing case appends exactly one fix lap to the plan");
	assert.equal(step.state.lap, 1, "the first fix lap is the lap now being worked");
	assert.match(step.text, /fix lap\(s\) were added/);
});

test("a case nobody could exercise ends as needs-human, not as a failure", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([unproven("c1")]));
	assert.equal(step.action, "human");
	assert.equal(step.state.outcome, "needs-human");
	assert.match(step.text, /needs a human/);
});

test("the same goal resumes its attempt count; a different goal starts fresh", () => {
	const first = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([fail("c1")]));
	const same = resumeOrStart(first.state, "  SHIP   it ");
	assert.equal(same, first.state, "whitespace and case do not start a new run");
	const other = resumeOrStart(first.state, "something else");
	assert.equal(other.attempts.rounds, 0);
	assert.notEqual(goalKey("a  b"), goalKey("a b c"));
});

test("a finished run is never resumed, even for the same goal", () => {
	const done = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([pass("c1")])).state;
	const again = resumeOrStart(done, "ship it");
	assert.notEqual(again, done);
	assert.equal(again.attempts.rounds, 0);
	assert.equal(again.doneAt, undefined);
});

test("the tool text keeps one header line and swaps in whatever body the driver produced", () => {
	const started = freshGoalRun("ship it");
	const step = nextGoalDriverStep(started, buildReport([pass("c1")]));
	const text = buildGoalToolText(started, step, "BODY");
	assert.match(text, /goal confirmed once: ship it/);
	assert.match(text, /BODY/);
	assert.ok(!text.includes("every case is backed by code that was actually run"), "the override replaces the default body");
});
