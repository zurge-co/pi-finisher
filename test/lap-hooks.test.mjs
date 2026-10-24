import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declarePlan, completeLap } from "../extensions/finisher/index.ts";
import { trackerPath, readLapTracker } from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-lap-hooks-"));

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
const planOf = (texts) => declarePlan(texts, 1_000);

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

const turnEnd = (hooks, ctx) =>
	fire(hooks, "turn_end", { type: "turn_end", turnIndex: 1, outcome: "completed", message: { role: "assistant" }, toolResults: [], entries: [], continue: false, context: { contextEntries: [{ type: "message", id: "m1", message: { role: "user" } }] } }, ctx);

const prompt = (hooks, ctx) =>
	fire(hooks, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "go", systemPrompt: "you are a coding agent" }, ctx);

const withPlan = (texts, lap = 1) => {
	const plan = planOf(texts);
	const advanced = lap === 1 ? plan : Array.from({ length: lap - 1 }).reduce((p) => ({ ...p, ...completeLap(p, undefined, p.lapAt + 1_000) }), plan);
	return { ...BASE, goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 0 }, phases: advanced.phases, lap: advanced.lap, lapAt: advanced.lapAt, lapMs: advanced.lapMs, cases: ["typecheck passes"] } };
};

test("the turn_end hook writes the tracker while a lap is open, and deletes it the moment the goal closes", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();

	const open = session(cwd, withPlan(["read the parser", "rewrite the retry policy"]));
	await fire(hooks, "session_start", {}, open);
	await turnEnd(hooks, open);
	const written = readLapTracker(cwd);
	assert.ok(written, "an open goal must leave a tracker on disk for the next lap to read");
	assert.equal(written.lap, 1);
	assert.equal(written.current.text, "read the parser");
	assert.equal(trackerPath(cwd).endsWith(".finisher/tracker.json"), true);

	const closed = session(cwd, { ...BASE, goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 1 }, doneAt: 9_000, outcome: "verified" } });
	await fire(hooks, "session_start", {}, closed);
	await turnEnd(hooks, closed);
	assert.equal(existsSync(trackerPath(cwd)), false, "a stale tracker after the goal closed would tell the next task to keep working");
});

test("a lap boundary compacts once, and the compaction carries the lap the run is actually on", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();
	const ctx = session(cwd, withPlan(["read the parser", "rewrite the retry policy", "prove it"], 2));
	await fire(hooks, "session_start", {}, ctx);

	const first = await turnEnd(hooks, ctx);
	assert.ok(first?.entries, "closing a lap is a boundary the model must not carry the old lap across");
	const compaction = first.entries.find((e) => e.type === "compaction");
	const notice = first.entries.find((e) => e.type === "custom_message");
	assert.ok(compaction, "the context is cleared by a compaction entry");
	assert.ok(notice, "the tracker is handed forward as a message the model reads before the reset");
	assert.ok(compaction.summary.includes("where: lap 2/3"), "the summary states the lap that is still open");
	assert.ok(compaction.summary.includes("now: rewrite the retry policy"), "the summary states what that lap has to do");
	assert.ok(!compaction.summary.includes("now: read the parser"), "the finished lap is not handed back as open work");
	assert.equal(notice.customType, "finisher-tracker");
	assert.equal(notice.content, compaction.summary, "both entries say the same thing, so the lap cannot be read two ways");
	assert.equal(notice.display, false, "the tracker is state, not a message the human scrolls past");

	const second = await turnEnd(hooks, ctx);
	assert.equal(second, undefined, "the same lap boundary never compacts twice");
});

test("an aborted turn keeps its context, so a human can still read what happened", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();
	const ctx = session(cwd, withPlan(["a", "b"], 2));
	await fire(hooks, "session_start", {}, ctx);
	const out = await fire(hooks, "turn_end", { type: "turn_end", turnIndex: 1, outcome: "aborted", message: { role: "assistant" }, toolResults: [], entries: [], continue: false, context: { contextEntries: [{ type: "message", id: "m1", message: { role: "user" } }] } }, ctx);
	assert.equal(out, undefined, "an aborted run is not a boundary");
	assert.ok(readLapTracker(cwd), "the tracker still exists, because the goal is still open");
});

test("every model request carries the lap tracker, and it names the current lap", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();
	const ctx = session(cwd, withPlan(["read the parser", "rewrite the retry policy", "prove it"], 2));
	await fire(hooks, "session_start", {}, ctx);

	const first = await prompt(hooks, ctx);
	assert.match(first.systemPrompt, /^you are a coding agent/, "the host prompt stays first");
	assert.match(first.systemPrompt, /\[finisher lap tracker\] goal: ship it/);
	assert.match(first.systemPrompt, /where: lap 2\/3/);
	assert.match(first.systemPrompt, /now: rewrite the retry policy/);
	assert.match(first.systemPrompt, /then: prove it/);
	assert.match(first.systemPrompt, /cases: typecheck passes/);

	const second = await prompt(hooks, ctx);
	assert.equal(second.systemPrompt, first.systemPrompt, "the tracker is a function of state, so an idle turn cannot make the prompt drift");

	const noGoal = session(cwd, BASE);
	await fire(hooks, "session_start", {}, noGoal);
	const plain = await prompt(hooks, noGoal);
	assert.ok(!plain.systemPrompt.includes("[finisher lap tracker]"), "no goal means no tracker, and the prompt is just the harness rules");
});

test("after the goal closes, the prompt stops carrying a tracker — a finished run is not work in progress", async () => {
	const hooks = await loadHarness();
	const cwd = tmpRepo();
	const ctx = session(cwd, { ...BASE, goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 1 }, doneAt: 9_000, outcome: "verified", phases: planOf(["a"]).phases, lap: 2 } });
	await fire(hooks, "session_start", {}, ctx);
	const out = await prompt(hooks, ctx);
	assert.ok(!out.systemPrompt.includes("[finisher lap tracker]"));
});
