import { test } from "node:test";
import assert from "node:assert/strict";
import {
	GOAL_AFTER_CONFIRM_NOTE,
	buildGoalConfirmPrompt,
	confirmGoal,
	goalCases,
	goalConfirmModeLine,
	goalGate,
} from "../extensions/finisher/index.ts";

const goal = { goal: "ship the swarm" };

test("the goal gate is open only after a confirmation, and confirmation is idempotent in shape", () => {
	assert.equal(goalGate(undefined), "unconfirmed");
	assert.equal(goalGate(goal), "unconfirmed");
	const once = confirmGoal(goal, 1000);
	const twice = confirmGoal(once, 2000);
	assert.equal(goalGate(once), "confirmed");
	assert.equal(goalGate(twice), "confirmed");
	assert.equal(once.signature, "ship the swarm@1000");
	assert.equal(twice.signature, "ship the swarm@2000");
	assert.equal(twice.goal, goal.goal, "confirming must never rewrite what the human asked for");
});

test("the confirmed cases are the spec's own cases, in order, with no invented extras", () => {
	const spec = { crossCheck: ["A holds", "B holds", "A holds"], outcomes: "legacy text", intent: "intent" };
	assert.deepEqual(goalCases(spec), ["A holds", "B holds", "A holds"]);
	assert.deepEqual(goalCases({ crossCheck: [], outcomes: "first\n\nsecond\n", intent: "intent" }), ["first", "second"]);
	assert.deepEqual(goalCases({ crossCheck: [], outcomes: "", intent: " only the intent " }), ["only the intent"]);
});

test("the single confirmation prompt shows every case and promises no further gate", () => {
	const p = buildGoalConfirmPrompt("ship the swarm", ["A holds", "B holds"]);
	assert.ok(p.indexOf("A holds") < p.indexOf("B holds"), "cases must keep their order");
	assert.match(p, /1\. A holds/);
	assert.match(p, /2\. B holds/);
	assert.match(p, /no further approval is asked/);
	assert.match(p, /no gates/i);
	assert.doesNotMatch(p, /\?$/m, "a confirmation is not a question list — it must not beg for clarification");
});

test("the post-confirmation mode is stated: no gate, no ceiling, ladder in parallel", () => {
	const line = goalConfirmModeLine();
	assert.match(line, /goal-confirm/);
	assert.match(line, /no per-step approval/);
	assert.match(line, /no token or cost ceiling/);
	assert.match(line, /priority1\.\.priority5/);
	assert.match(GOAL_AFTER_CONFIRM_NOTE, /verify every case/);
});
