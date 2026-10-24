import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TRACKER_RENDER_MAX,
	TRACKER_STEPS_MAX,
	buildLapTracker,
	clearLapTracker,
	readLapTracker,
	renderLapTracker,
	stepStateOf,
	stepsOf,
	trackerEvidence,
	trackerPath,
	writeLapTracker,
} from "../extensions/finisher/index.ts";
import { declarePlan, completeLap } from "../extensions/finisher/index.ts";
import { freshGoalRun } from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-tracker-"));

const goalWith = (plan, cases = []) => ({ ...freshGoalRun("ship the parser", 1_000, cases), phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs });

test("the plan has exactly one current lap at every point, and closing a lap moves that mark by one", () => {
	for (const total of [1, 2, 3, 9]) {
		const texts = Array.from({ length: total }, (_, i) => `lap ${i + 1}`);
		let plan = declarePlan(texts, 0);
		for (let closed = 0; closed <= total; closed++) {
			const states = stepsOf(plan).map((s) => s.state);
			const current = states.filter((s) => s === "current").length;
			const done = states.filter((s) => s === "done").length;
			const finished = plan.lap > total;
			assert.equal(current, finished ? 0 : 1, `total ${total}, closed ${closed}: exactly one current lap while the plan is open`);
			assert.equal(done, Math.min(total, plan.lap - 1), `total ${total}, closed ${closed}: every lap before the current one is done and none after`);
			assert.equal(states[0] === "current", plan.lap === 1, "the first lap is the current one before anything is closed");
			if (!finished) plan = { ...plan, ...completeLap(plan, undefined, 2_000) };
			assert.ok(plan.lap <= total + 1, "a lap close never overshoots the plan");
		}
	}
});

test("the state of a lap is a function of its position and the current lap only — the same plan cannot describe two different worlds", () => {
	const plan = declarePlan(["a", "b", "c", "d"], 0);
	for (let lap = 1; lap <= 5; lap++) {
		for (let index = 0; index < plan.phases.length; index++) {
			const state = stepStateOf({ ...plan, lap }, index);
			const expected = lap > plan.phases.length ? "done" : index + 1 < lap ? "done" : index + 1 === lap ? "current" : "todo";
			assert.equal(state, expected, `lap ${lap} index ${index}`);
		}
	}
});

test("the evidence list keeps the last status per command, so a fixed command is not reported as still failing", () => {
	const calls = [
		{ command: "npm test", ok: false },
		{ command: "npm  test", ok: true },
		{ command: "npm run typecheck", ok: true },
	];
	const evidence = trackerEvidence(calls, 5);
	assert.deepEqual(evidence.map((e) => [e.command, e.ok]), [["npm test", true], ["npm run typecheck", true]], "the retried command carries its final status, deduped");
	const many = Array.from({ length: 40 }, (_, i) => ({ command: `cmd ${i}`, ok: i % 2 === 0 }));
	assert.equal(trackerEvidence(many, 5).length, 5, "the tracker is bounded, never a transcript");
	assert.deepEqual(trackerEvidence(many, 5).map((e) => e.command), ["cmd 35", "cmd 36", "cmd 37", "cmd 38", "cmd 39"], "the most recent commands are the ones kept");
});

test("the tracker file exists exactly while a goal is open, and it round-trips what the next lap needs", () => {
	const cwd = tmpRepo();
	const plan = declarePlan(["read the parser", "rewrite the retry policy", "prove it"], 0);
	const goal = goalWith(plan, ["typecheck passes", "tests pass"]);
	assert.equal(writeLapTracker(cwd, goal, [{ command: "npm test", ok: true }], 5_000), trackerPath(cwd));
	const read = readLapTracker(cwd);
	assert.equal(read.goal, "ship the parser");
	assert.equal(read.lap, 1);
	assert.equal(read.laps, 3);
	assert.equal(read.current.text, "read the parser");
	assert.deepEqual(read.next.map((s) => s.text), ["rewrite the retry policy", "prove it"]);
	assert.deepEqual(read.cases, ["typecheck passes", "tests pass"]);
	assert.deepEqual(read.evidence, [{ command: "npm test", ok: true }]);

	const advanced = { ...goal, ...completeLap(plan, undefined, 6_000) };
	writeLapTracker(cwd, advanced, [], 7_000);
	const second = readLapTracker(cwd);
	assert.equal(second.lap, 2, "a fresh lap is what the file reports");
	assert.equal(second.done, 1);
	assert.equal(second.current.text, "rewrite the retry policy");

	writeLapTracker(cwd, { ...advanced, doneAt: 9_000, outcome: "verified" }, [], 9_000);
	assert.equal(existsSync(trackerPath(cwd)), false, "a closed goal leaves no tracker behind — a stale one would mislead the next task");
	assert.equal(readLapTracker(cwd), undefined);
	assert.equal(writeLapTracker(cwd, undefined, [], 9_000), undefined, "no goal means no file");
	assert.equal(existsSync(trackerPath(cwd)), false);
});

test("the rendered tracker is bounded and always carries the goal and the current lap, whatever the plan length", () => {
	for (const total of [0, 1, 3, 40, 200]) {
		const texts = Array.from({ length: total }, (_, i) => `lap ${i + 1} ${"detail ".repeat(20)}`);
		const plan = total ? declarePlan(texts, 0) : { phases: [], lap: 0, lapAt: 0, lapMs: [] };
		const goal = goalWith(plan, Array.from({ length: 30 }, (_, i) => `case ${i} ${"x".repeat(300)}`));
		const tracker = buildLapTracker(goal, Array.from({ length: 30 }, (_, i) => ({ command: `cmd ${i} ${"y".repeat(200)}`, ok: i % 3 !== 0 })), 1_000);
		const text = renderLapTracker(tracker);
		assert.ok(text.length <= TRACKER_RENDER_MAX, `total ${total}: the tracker must stay small enough to ride every turn (${text.length})`);
		assert.ok(text.startsWith("[finisher lap tracker] goal: "), "the goal always leads, so a truncated tracker still says what is being built");
		assert.ok(text.includes("where: "), "the lap position survives truncation");
		if (total) {
			assert.ok(text.includes(`where: lap 1/${total}`), `total ${total}: the current lap number is stated`);
			assert.ok(text.includes("now: lap 1"), `total ${total}: the current lap's own text is stated`);
			assert.ok(text.split("\n").filter((l) => /^\s+[✓▶·] \d+\./.test(l)).length <= TRACKER_STEPS_MAX, `total ${total}: the plan window is capped`);
		} else {
			assert.ok(text.includes("no plan declared yet"), "an undeclared plan says so instead of inventing a lap");
		}
	}
});

test("clearing is idempotent, so a repeated reset cannot fail the run", () => {
	const cwd = tmpRepo();
	assert.equal(clearLapTracker(cwd), true, "clearing a tracker that was never written is not an error");
	writeLapTracker(cwd, goalWith(declarePlan(["a"], 0)), [], 1_000);
	assert.equal(existsSync(trackerPath(cwd)), true);
	assert.equal(clearLapTracker(cwd), true);
	assert.equal(existsSync(trackerPath(cwd)), false);
});
