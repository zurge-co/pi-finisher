import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import finisher from "../extensions/finisher/index.ts";
import { CLARIFY_MAX, INTAKE_GRACE_CALLS, intakeDirective } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;

const liveHarness = (overrides = {}) => {
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
	const ctx = { cwd: process.cwd(), hasUI: false, mode: "headless", ui: { notify: () => {} }, sessionManager: { getEntries: () => [] }, ...overrides };
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
	assert.match(blocked.reason, /goal/, "the refusal names the tool that opens the gate");
	assert.equal(await harness.call("goal", { goal: "ship it" }), undefined, "the gate can never stand between the agent and the goal tool");
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
	assert.match(text, /goal/);
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
	const result = await harness.run("goal", { goal: "make it better", cases: [], lang: "en" });
	assert.equal(result.details.outcome, "unavailable", "no UI means no dialog, and no invented confirmation");
	assert.match(result.content[0].text, /no dialog/, "the refusal says why");
});

test("confirming a goal resets the intake budget, so a confirmed run explores freely", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /state\.goalDriver = adopted[\s\S]{0,400}state\.preGoalCalls = 0/, "the counter is reset where the goal is adopted, not somewhere else");
	assert.equal(INTAKE_GRACE_CALLS > 0, true, "a zero budget would block the very first look at the repo");
});

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text, dim: (text) => text, style: (text) => text, colors: {}, appearance: "dark" };

const humanUi = (seen) => ({
	cwd: process.cwd(),
	hasUI: true,
	mode: "tui",
	ui: {
		notify: () => {},
		setWidget: () => {},
		custom: (factory, options) =>
			new Promise((resolve) => {
				const handle = { setHidden: () => {}, hide: () => {}, isHidden: () => false, focus: () => {}, unfocus: () => {}, isFocused: () => true, getBounds: () => undefined };
				options?.onHandle?.(handle);
				const component = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, theme, () => "", resolve);
				seen.push(component.render(120).join("\n"));
				component.handleInput("\r");
			}),
	},
	sessionManager: { getEntries: () => [{ type: "message", message: { role: "user" } }], getSessionId: () => "session-clarify" },
});

test("the real goal tool asks its bounded round first, and the confirm dialog is handed what the human sharpened", async () => {
	const seen = [];
	const vague = await liveHarness(humanUi(seen)).run("goal", { goal: "make it better", cases: ["it works"], lang: "en" });
	assert.equal(vague.isError, undefined, "a vague goal is still confirmable: the ask sharpens it, it never gates it");
	const questions = seen.slice(0, -1);
	assert.ok(questions.length >= 1 && questions.length <= CLARIFY_MAX, `asked ${questions.length} questions, never more than the bound`);
	for (const page of questions) assert.match(page, /as I said is enough/, "every question carries the escape, so the human can stop at any point");
	const dialog = seen.at(-1);
	assert.match(dialog, /make it better/, "the human's own words are still the goal they confirm");
	assert.match(dialog, /it works/, "and the case they already gave is not lost on the way");
	assert.match(dialog, /npm test exits 0/, "the observable the human picked reaches the dialog as a case the harness can check");

	const quiet = [];
	const sharp = await liveHarness(humanUi(quiet)).run("goal", { goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"], lang: "en" });
	assert.equal(sharp.isError, undefined);
	assert.equal(quiet.length, 1, "a goal that is already specific goes straight to the confirm dialog, asking nothing");
	assert.match(quiet[0], /src\/hud\.ts/, "and that dialog shows the goal it was given");
});
