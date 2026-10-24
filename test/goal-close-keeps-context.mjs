import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLap, declarePlan, freshLapDecision, trackerPath } from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-goal-close-"));

const loadHarness = async () => {
	const ext = (await import("../extensions/finisher/index.ts")).default;
	const hooks = new Map();
	const pi = {
		on: (name, fn) => {
			hooks.set(name, [...(hooks.get(name) ?? []), fn]);
			return () => {};
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerVirtualModel: () => {},
		appendEntry: () => {},
	};
	const saved = process.env.PI_FINISHER_SUBAGENT;
	process.env.PI_FINISHER_SUBAGENT = "0";
	try {
		ext(pi);
	} finally {
		if (saved === undefined) delete process.env.PI_FINISHER_SUBAGENT;
		else process.env.PI_FINISHER_SUBAGENT = saved;
	}
	return hooks;
};

const BASE = { phase: "requirements", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] };

const session = (cwd, state) => ({
	cwd,
	mode: "rpc",
	hasUI: false,
	ui: { notify: () => {}, setWidget: () => {}, setWorkingIndicator: () => {}, setWorkingMessage: () => {} },
	sessionManager: { getEntries: () => [{ type: "custom", customType: "finisher-state", data: state }] },
});

const fire = async (hooks, name, event, ctx) => {
	let out;
	for (const h of hooks.get(name) ?? []) {
		const r = await h(event, ctx);
		if (r !== undefined) out = r;
	}
	return out;
};

const CONTEXT = [{ type: "message", id: "u1", message: { role: "user" } }, { type: "message", id: "a1", message: { role: "assistant" } }];

const turnEnd = (hooks, ctx, outcome = "completed") =>
	fire(hooks, "turn_end", { type: "turn_end", turnIndex: 1, outcome, message: { role: "assistant" }, toolResults: [], entries: [], continue: false, context: { contextEntries: CONTEXT } }, ctx);

const crossedLap = (texts, laps) => {
	let plan = declarePlan(texts, 1_000);
	for (let i = 1; i < laps; i++) plan = { ...plan, ...completeLap(plan, undefined, plan.lapAt + 1_000) };
	return plan;
};

const closedGoal = (plan, outcome = "verified") => ({
	...BASE,
	goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 2 }, doneAt: 60_000, outcome, phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs, cases: ["typecheck passes"] },
	humanAt: 61_000,
});

test("a closed goal is never a compaction boundary, whatever lap its plan stopped on — the transcript and the report stay readable", async () => {
	const hooks = await loadHarness();
	assert.equal(hooks.has("agent_before_settle"), false, "no settle-time reset path exists at all, so a closed goal cannot clear the screen on the way out");

	for (const laps of [1, 2, 3]) {
		for (const outcome of ["verified", "halted"]) {
			const cwd = tmpRepo();
			const ctx = session(cwd, closedGoal(crossedLap(["read the parser", "rewrite the retry policy", "prove it"], laps), outcome));
			await fire(hooks, "session_start", {}, ctx);
			assert.equal(await turnEnd(hooks, ctx), undefined, `laps=${laps} outcome=${outcome}: the run that just closed must hand the context over intact`);
			assert.equal(existsSync(trackerPath(cwd)), false, "the pointer to a finished plan is removed, so the next task does not inherit it");
		}
	}
});

test("a closed goal stays silent even when the bookkeeping of an earlier lap boundary is already spent", async () => {
	const hooks = await loadHarness();
	const plan = crossedLap(["a", "b"], 2);
	for (const patch of [{}, { freshResetAt: 59_000, freshResetLapAt: plan.lapAt }, { humanAt: 0 }]) {
		const ctx = session(tmpRepo(), { ...closedGoal(plan), ...patch });
		await fire(hooks, "session_start", {}, ctx);
		assert.equal(await turnEnd(hooks, ctx), undefined, `state ${JSON.stringify(patch)} must not reopen a boundary the goal already passed`);
	}
});

test("the lap rule itself scores a closed goal as no boundary, so the guard is not only the hook's early return", () => {
	for (const laps of [1, 2, 3]) {
		for (const doneAt of [60_000, 1_000_500]) {
			const plan = crossedLap(["read the parser", "rewrite the retry policy", "prove it"], laps);
			const goal = { ...plan, goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 1 }, doneAt };
			for (const consumedLapAt of [undefined, plan.lapAt, plan.lapAt - 1_000])
				assert.equal(freshLapDecision({ enabled: true, hasWork: true, goal, consumedLapAt, now: doneAt + 60_000 }).reset, false, `laps=${laps} doneAt=${doneAt} consumedLapAt=${consumedLapAt}: a closed goal has no lap boundary left to cross`);
		}
	}
});

test("the lap boundary the run still needs survives next to the removed goal path: one compaction per lap, and none for a goal that closed", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();
	const ctx = session(cwd, { ...BASE, goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 0 }, ...crossedLap(["read the parser", "rewrite the retry policy", "prove it"], 2) } });
	await fire(hooks, "session_start", {}, ctx);

	const first = await turnEnd(hooks, ctx);
	assert.equal(first.entries.filter((e) => e.type === "compaction").length, 1, "a lap that really closed is still summarized once");
	assert.equal(first.entries.length, 2, "one compaction and the tracker message that outlives it");
	assert.equal(await turnEnd(hooks, ctx), undefined, "and never twice for the same lap");

	const done = session(cwd, closedGoal(crossedLap(["read the parser", "rewrite the retry policy", "prove it"], 2)));
	await fire(hooks, "session_start", {}, done);
	assert.equal(await turnEnd(hooks, done), undefined, "the same run, once its goal is closed, is no longer a boundary");
});
