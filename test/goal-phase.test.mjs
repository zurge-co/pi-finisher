import { test } from "node:test";
import assert from "node:assert/strict";

const evidence = (body) => (String(body).trim() ? `EVIDENCE:\n${body}` : "");
import {
	allLapsDone,
	appendPhases,
	applyPhaseCall,
	buildReport,
	completeLap,
	currentLap,
	declarePlan,
	emptyPlan,
	fixPhases,
	freshGoalRun,
	judgeCase,
	lapLabel,
	nextGoalDriverStep,
	planOf,
	totalPhases,
	verifyGate,
} from "../extensions/finisher/index.ts";

const state = (plan, goal = "ship it") => {
	const d = declarePlan(["a", "b", "c"]);
	return { goalDriver: { goal, confirmedAt: 1_000, attempts: { rounds: 0 }, phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs }, d };
};

test("a lap can only ever advance by one, and only when it is the lap being closed", () => {
	for (const total of [1, 2, 3, 7]) {
		const texts = Array.from({ length: total }, (_, i) => `lap ${i + 1}`);
		const declared = declarePlan(texts, 0);
		for (let lap = 1; lap <= total; lap++) {
			const start = { ...declared, lap, lapAt: 1_000, lapMs: [] };
			for (let ref = 1; ref <= total; ref++) {
				const next = completeLap(start, ref, 2_000);
				assert.equal(next.lap, ref === lap ? lap + 1 : lap, `total ${total} at lap ${lap}, closing ${ref}`);
				assert.ok(next.lap - start.lap <= 1, "a close can never skip a lap");
			}
			for (const p of declared.phases) {
				const byId = completeLap(start, p.id, 2_000);
				if (p.id === declared.phases[lap - 1].id) assert.equal(byId.lap, lap + 1, "closing the current lap by id advances it");
				else assert.equal(byId.lap, lap, `closing ${p.id} out of order is refused`);
			}
		}
	}
});

test("an out-of-order close credits no lap time and never reaches the verify gate", () => {
	const plan = declarePlan(["survey", "rewrite", "prove"], 0);
	const atFirstLap = { ...plan, lap: 1, lapAt: 1_000, lapMs: [] };
	const jumped = completeLap(atFirstLap, "p-prove", 9_000);
	assert.equal(jumped.lap, 1, "a future lap cannot be closed early");
	assert.deepEqual(jumped.lapMs, [], "no lap time is invented for work that never happened");
	assert.equal(allLapsDone(jumped), false);
	assert.equal(verifyGate(jumped).allowed, false, "verify stays gated while laps 1 and 2 are untouched");
});

test("closing laps in order is what unlocks verification, exactly once", () => {
	let plan = declarePlan(["one", "two"], 1_000);
	assert.equal(verifyGate(plan).allowed, false);
	plan = completeLap(plan, undefined, 2_000);
	assert.equal(verifyGate(plan).allowed, false, "one lap closed is not the end of the plan");
	plan = completeLap(plan, undefined, 5_000);
	assert.equal(plan.lap, 3);
	assert.equal(allLapsDone(plan), true);
	assert.equal(verifyGate(plan).allowed, true);
	assert.deepEqual(plan.lapMs, [1_000, 3_000], "each lap keeps its own spent time");
	const again = completeLap(plan, undefined, 6_000);
	assert.deepEqual(again, plan, "a closed plan cannot be closed again");
});

test("a failing verify appends fix laps without reopening work that is already done", () => {
	const plan = declarePlan(["one"], 0);
	const closed = completeLap(plan, undefined, 2_000);
	const report = { cases: [{ caseId: "c1", verdict: "FAIL", reason: "exit 1", commands: [] }], allPass: false, unverified: [], failed: ["c1"] };
	const grown = appendPhases(closed, fixPhases(report), 1, 3_000);
	assert.equal(totalPhases(grown), 2, "the fix adds exactly one lap");
	assert.equal(grown.lap, closed.lap, "appending never moves the lap pointer");
	assert.deepEqual(grown.lapMs, closed.lapMs, "the time already spent is not thrown away");
	assert.match(grown.phases[1].text, /c1/, "the fix lap names the case it exists for");
});

test("a goal with no plan is never gated, and a blank plan is not a plan", () => {
	assert.deepEqual(declarePlan([], 0), emptyPlan());
	assert.deepEqual(declarePlan(["", "   ", "\t", "\n"], 0), emptyPlan());
	assert.equal(verifyGate(emptyPlan()).allowed, true, "a goal that never declared a plan can still verify");
	assert.equal(lapLabel(emptyPlan()), "PLAN");
});

test("the phase tool refuses to close a lap that is not current, and says which one is", () => {
	const plan = declarePlan(["survey", "rewrite", "prove"], 0);
	const s = state({ ...plan, lap: 2, lapAt: 1_000, lapMs: [500] });
	const blocked = applyPhaseCall(s, { done: "p-prove" }, 9_000);
	assert.equal(blocked.action, "blocked");
	assert.match(blocked.text, /not the current lap/);
	assert.match(blocked.text, /LAP 2\/3/, "the refusal names the lap that is actually open");
	assert.equal(s.goalDriver.lap, 2, "a refused close changes nothing");
	const ok = applyPhaseCall(s, { done: true }, 9_000);
	assert.equal(ok.action, "done");
	assert.equal(s.goalDriver.lap, 3);
	const last = applyPhaseCall(s, { done: "p-prove" }, 10_000);
	assert.equal(last.action, "done");
	assert.equal(allLapsDone(planOf(s.goalDriver)), true);
	assert.deepEqual(s.goalDriver.lapMs, [500, 8_000, 1_000], "every close records the lap it actually closed");
});

test("a plan that grows from a first-round failure is never left without a current lap", () => {
	const opened = { goalDriver: freshGoalRun("ship it", 1_000) };
	const failing = buildReport([judgeCase("c1", evidence('$ node -e "run()"\nexit code 1\nVERDICT: FAIL'))]);
	const step = nextGoalDriverStep(opened.goalDriver, failing, 3, 5_000);
	assert.equal(step.action, "replan");
	opened.goalDriver = step.state;
	const plan = planOf(step.state);
	assert.equal(plan.phases.length, 1, "the fix lap exists");
	assert.equal(plan.lap, 1, "and it is the lap being worked, not an empty pointer");
	assert.notEqual(currentLap(plan), undefined, "a plan with laps always has a current lap");
	const closed = applyPhaseCall(opened, { done: true }, 8_000);
	assert.equal(closed.action, "done");
	assert.equal(opened.goalDriver.lap, 2, "closing it advances exactly one lap, never two");
	assert.deepEqual(opened.goalDriver.lapMs, [3_000], "the lap records its own time");
});

test("no plan produced by any entry point has laps but no current lap", () => {
	const plans = [
		emptyPlan(),
		declarePlan(["a"], 1_000),
		declarePlan(["a", "b", "c"], 1_000),
		appendPhases(emptyPlan(), ["a"], 1, 2_000),
		appendPhases(declarePlan(["a"], 1_000), ["fix"], 1, 2_000),
		completeLap(declarePlan(["a", "b"], 1_000), undefined, 2_000),
		completeLap(declarePlan(["a", "b"], 1_000), "p-b", 2_000),
	];
	for (const plan of plans) {
		if (!totalPhases(plan)) continue;
		assert.notEqual(currentLap(plan), undefined, `${lapLabel(plan)} must name a lap that exists`);
		assert.ok(plan.lap >= 1 && plan.lap <= totalPhases(plan) + 1, `${lapLabel(plan)} is in range`);
	}
	const grown = appendPhases(emptyPlan(), ["a", "b"], 1, 2_000);
	assert.equal(grown.lap, 1);
	assert.equal(grown.lapAt, 2_000, "a grown plan starts its first lap clock");
});
