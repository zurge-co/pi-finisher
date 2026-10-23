import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHandoff, clearOtherGoals, goalKey, handoffForGoal, handoffInjection, readHandoff, writeHandoff } from "../extensions/zense-harness/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "zense-goal-scope-"));

test("a note carries the goal it was learned in", () => {
	const cwd = tmpRepo();
	appendHandoff(cwd, { at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal: goalKey("ship it") });
	const items = readHandoff(cwd);
	assert.equal(items.length, 1);
	assert.equal(items[0].goal, goalKey("ship it"));
});

test("inside one goal, notes accumulate across loops — that is the point of the stack", () => {
	const cwd = tmpRepo();
	const goal = goalKey("ship it");
	appendHandoff(cwd, { at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal });
	appendHandoff(cwd, { at: 2, from: "verifier", text: "the cli reads stdin when no file is given", goal });
	assert.equal(handoffForGoal(cwd, "ship it").length, 2);
	assert.match(handoffInjection(handoffForGoal(cwd, "ship it")) ?? "", /exclusive/);
});

test("a different goal never sees another goal's notes", () => {
	const cwd = tmpRepo();
	appendHandoff(cwd, { at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal: goalKey("ship it") });
	assert.deepEqual(handoffForGoal(cwd, "a completely different goal"), []);
	assert.equal(handoffInjection(handoffForGoal(cwd, "a completely different goal")), undefined);
});

test("starting a new goal clears the notes of the old one", () => {
	const cwd = tmpRepo();
	appendHandoff(cwd, { at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal: goalKey("old goal") });
	const kept = clearOtherGoals(cwd, "new goal");
	assert.deepEqual(kept, [], "the old goal's knowledge does not leak into the new one");
	assert.deepEqual(readHandoff(cwd), []);
});

test("clearing for the same goal keeps that goal's notes", () => {
	const cwd = tmpRepo();
	const goal = goalKey("ship it");
	appendHandoff(cwd, { at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal });
	appendHandoff(cwd, { at: 2, from: "swarm", text: "the cli reads stdin when no file is given", goal });
	const kept = clearOtherGoals(cwd, "ship it");
	assert.equal(kept.length, 2);
	assert.equal(readHandoff(cwd).length, 2);
});

test("a legacy note without a goal stays visible, so an upgrade never silently empties the stack", () => {
	const cwd = tmpRepo();
	writeHandoff(cwd, [{ at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive" }]);
	assert.equal(handoffForGoal(cwd, "any goal").length, 1);
});

test("an undefined goal means no filtering at all", () => {
	const cwd = tmpRepo();
	writeHandoff(cwd, [
		{ at: 1, from: "swarm", text: "the scheduler bound is exclusive, not inclusive", goal: "a" },
		{ at: 2, from: "swarm", text: "the cli reads stdin when no file is given", goal: "b" },
	]);
	assert.equal(handoffForGoal(cwd, undefined).length, 2);
});
