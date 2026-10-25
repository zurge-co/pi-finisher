import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import finisher from "../extensions/finisher/index.ts";
import { INTAKE_GRACE_CALLS, intakeDirective } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;

const liveHarness = () => {
	const handlers = {};
	const tools = {};
	const pi = {
		on: (name, fn) => {
			(handlers[name] ??= []).push(fn);
		},
		registerTool: (definition) => {
			tools[definition.name] = definition;
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerVirtualModel: () => {},
		appendEntry: () => {},
	};
	finisher(pi);
	const ctx = { cwd: process.cwd(), hasUI: false, mode: "headless", ui: { notify: () => {} }, sessionManager: { getEntries: () => [] } };
	const call = async (toolName, input = {}) => {
		for (const handler of handlers.tool_call ?? []) {
			const r = await handler({ toolName, input }, ctx);
			if (r?.block) return r;
		}
		return undefined;
	};
	const prompt = async (text) => {
		let out;
		for (const handler of handlers.before_agent_start ?? []) {
			const r = await handler({ messageType: "user", prompt: text, systemPrompt: "base" }, ctx);
			if (r?.systemPrompt) out = r.systemPrompt;
		}
		return out ?? "";
	};
	return { call, prompt, run: (name, input) => tools[name].execute("call-1", input, undefined, undefined, ctx) };
};

test("the running extension closes code exploration once the pre-goal budget is spent, and never before", async () => {
	const harness = liveHarness();
	for (let used = 0; used < INTAKE_GRACE_CALLS; used++) assert.equal(await harness.call("read", { path: "src/a.ts" }), undefined, `exploratory call ${used + 1} is still inside the budget`);
	const blocked = await harness.call("bash", { command: "grep -rn x ." });
	assert.equal(blocked?.block, true, "the budget is spent, so the next exploration is refused by the real hook");
	assert.match(blocked.reason, /finisher_goal/, "the refusal names the tool that opens the gate");
	assert.equal(await harness.call("finisher_goal", { goal: "ship it" }), undefined, "the gate can never stand between the agent and the goal tool");
});

test("a new human turn gives the intake budget back, so no goal is stonewalled across turns", async () => {
	const harness = liveHarness();
	for (let used = 0; used < INTAKE_GRACE_CALLS; used++) await harness.call("read", { path: "src/a.ts" });
	assert.equal((await harness.call("read", { path: "src/b.ts" }))?.block, true, "the budget is spent inside the turn");
	await harness.prompt("one more thing before you start");
	assert.equal(await harness.call("read", { path: "src/c.ts" }), undefined, "the human's new turn reopens the budget instead of stonewalling the agent");
});

test("the pre-goal system prompt carries the draft goal and every drafted case, before any exploration advice", async () => {
	const harness = liveHarness();
	const human = "Ship the report page. It must open from the HUD row";
	const text = await harness.prompt(human);
	assert.ok(text.includes(intakeDirective(human)), "the whole draft directive rides in the real prompt, not a paraphrase");
	assert.match(text, /finisher_goal/);
	assert.ok(text.includes("Ship the report page"), "the drafted goal is the human's own words");
	assert.ok(text.includes("It must open from the HUD row"), "and so is every drafted case");
});

test("the goal tool asks its bounded clarify round before the confirm dialog, and never asks twice", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /clarifyPlan\(\{ goal, cases: confirmed \}/, "the tool reads the gaps from the draft it is about to confirm");
	assert.match(tools, /plan\.ask[\s\S]{0,600}?askClarifyQuestion\(/, "and asks before the human is shown anything");
	assert.match(tools, /markClarify\(state, caseKey\(goal\)/, "the round is marked on the goal itself, so an unchanged goal never asks again");
	assert.match(tools, /askGoalConfirm\(ctx, askGoal, askCases\)/, "the dialog receives the sharpened goal text and the sharpened cases");
	assert.match(readFileSync(join(here, "extensions/finisher/src/gui.ts"), "utf8"), /askClarifyQuestion/, "and the session really provides the question dialog, not a stub");
});

test("a session with no dialog refuses the goal instead of waiting on a clarify question", async () => {
	const harness = liveHarness();
	const result = await harness.run("finisher_goal", { goal: "make it better", cases: [], lang: "en" });
	assert.equal(result.details.outcome, "unavailable", "no UI means no dialog, and no invented confirmation");
	assert.match(result.content[0].text, /no dialog/, "the refusal says why");
});

test("confirming a goal resets the intake budget, so a confirmed run explores freely", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /state\.goalDriver = adopted[\s\S]{0,400}state\.preGoalCalls = 0/, "the counter is reset where the goal is adopted, not somewhere else");
	assert.equal(INTAKE_GRACE_CALLS > 0, true, "a zero budget would block the very first look at the repo");
});
