import { writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import finisher from "../extensions/finisher/index.ts";
import { CLARIFY_MAX, CONSULT_GUIDELINE, GOAL_FIRST_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE, INTENT_GUIDELINE, WORK_FORCED_GUIDELINE, intakeDirective } from "../extensions/finisher/index.ts";

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
	const start = async () => {
		for (const handler of handlers.session_start ?? []) await handler({ type: "session_start" }, ctx);
	};
	return { call, prompt, start, run: (name, input) => tools[name].execute("call-1", input, undefined, undefined, ctx) };
};

test("nothing in the harness inspects the human's words: exploration is never refused, however many reads a turn takes", async () => {
	const harness = liveHarness();
	for (const ask of ["แก้บั๊กตอน logout", "ทำไม HUD ถึงกระพริบ", "what do you think about splitting the swarm module"]) {
		await harness.prompt(ask);
		for (let used = 0; used < 40; used++) assert.equal(await harness.call("read", { path: `src/${used}.ts` }), undefined, `${ask}: read ${used + 1} is the model's call, not a gate's`);
		assert.equal(await harness.call("bash", { command: "grep -rn x ." }), undefined, `${ask}: bash is never blocked before the goal`);
	}
	assert.equal(await harness.call("goal", { goal: "ship it" }), undefined, "and the goal tool was never gated either");
});

test("the words alone decide nothing: the same message reads as work in auto mode and as a conversation in always mode", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-consult-"));
	const message = "how would you structure the report page";
	const plain = await liveHarness({ cwd }).prompt(message);
	assert.ok(plain.includes(INTENT_GUIDELINE), "with no config the model is told to decide the turn itself");
	assert.ok(plain.includes(GOAL_WHEN_WORK_GUIDELINE), "and the goal it owes once it reads the message as work");
	assert.ok(!plain.includes(GOAL_FIRST_GUIDELINE), "but never the unconditioned demand, which would contradict the decision it was just given");
	assert.ok(!plain.includes(CONSULT_GUIDELINE));

	writeState(cwd, "config.json", JSON.stringify({ consultMode: "always" }));
	const forced = liveHarness({ cwd });
	await forced.start();
	const prompt = await forced.prompt(message);
	assert.ok(prompt.includes(CONSULT_GUIDELINE), "always is the human forcing the conversation, whatever the words");
	assert.ok(!prompt.includes(GOAL_FIRST_GUIDELINE) && !prompt.includes(GOAL_WHEN_WORK_GUIDELINE), "and no goal rule rides along with it");

	writeState(cwd, "config.json", JSON.stringify({ consultMode: "off" }));
	const off = liveHarness({ cwd });
	await off.start();
	const workTurn = await off.prompt("what do you think about the HUD");
	assert.ok(workTurn.includes(GOAL_FIRST_GUIDELINE), "off is the human refusing the conversation, whatever the words");
	assert.ok(!workTurn.includes(CONSULT_GUIDELINE));
});

test("the prompt the model reads carries the decision rule it is meant to apply, exactly once", async () => {
	const harness = liveHarness();
	const decide = await harness.prompt("add the missing case to the report page");
	assert.equal(decide.split(INTENT_GUIDELINE).length - 1, 1, "the decision rule reaches the prompt once and only once");
	assert.equal(decide.split(GOAL_WHEN_WORK_GUIDELINE).length - 1, 1, "and so does the goal it owes once the decision is work");
	assert.ok(!decide.includes(CONSULT_GUIDELINE));

	const offCwd = mkdtempSync(join(tmpdir(), "finisher-off-"));
	writeState(offCwd, "config.json", JSON.stringify({ consultMode: "off" }));
	const off = liveHarness({ cwd: offCwd });
	await off.start();
	const work = await off.prompt("add the missing case");
	assert.ok(work.includes(WORK_FORCED_GUIDELINE), "the mode the model has to honour is stated in the prompt it reads");
	assert.ok(!work.includes(INTENT_GUIDELINE), "and the decision it must not take is not offered to it");
});

test("the pre-goal system prompt carries the drafted goal and cases only in the mode that forces work", async () => {
	const human = "Ship the report page. It must open from the HUD row";
	const cwd = mkdtempSync(join(tmpdir(), "finisher-draft-"));
	const deciding = await liveHarness({ cwd }).prompt(human);
	assert.ok(deciding.includes(intakeDirective(human, undefined, "decide")), "auto rides the decide directive, not a draft the model must justify");
	assert.ok(!deciding.includes("case ="), "a turn still being judged is not handed a case list");
	writeState(cwd, "config.json", JSON.stringify({ consultMode: "off" }));
	const forced = liveHarness({ cwd });
	await forced.start();
	const text = await forced.prompt(human);
	assert.ok(text.includes(intakeDirective(human, undefined, "work")), "the whole draft directive rides in the real prompt, not a paraphrase");
	assert.match(text, /goal/);
	assert.ok(text.includes("Ship the report page"), "the drafted goal is the human's own words");
	assert.ok(text.includes("It must open from the HUD row"), "and so is every drafted case");
});

test("the mode is re-read from disk every turn: a switch mid-session lands on the next message and is announced once", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-switch-"));
	const notes = [];
	const harness = liveHarness({ cwd, ui: { notify: (text, kind) => notes.push({ text, kind }) } });
	await harness.start();

	const deciding = await harness.prompt("why does the HUD ticker keep repainting");
	assert.ok(deciding.includes(INTENT_GUIDELINE), "the first turn is the model deciding");
	assert.deepEqual(notes, [], "no switch has happened yet, so nothing is announced");

	writeState(cwd, "config.json", JSON.stringify({ consultMode: "always" }));
	assert.ok((await harness.prompt("still just asking")).includes(CONSULT_GUIDELINE), "the file is read again, not remembered from session_start");
	assert.equal(notes.length, 1, "the human is told their switch took effect");
	assert.match(notes[0].text, /always/, "and told which mode they are in now");
	assert.equal(notes[0].kind, "info");

	await harness.prompt("and now what");
	assert.equal(notes.length, 1, "an unchanged mode is never announced twice");

	writeState(cwd, "config.json", JSON.stringify({ consultMode: "off" }));
	assert.ok((await harness.prompt("keep going")).includes(WORK_FORCED_GUIDELINE), "off is honoured on the very next turn");
	assert.equal(notes.length, 2);
	assert.match(notes[1].text, /off/);
});

test("the goal tool asks its bounded clarify round before the confirm dialog, and never asks twice", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /clarifyPlan\(\{ goal, cases: confirmed \}, state, caseKey\(goal\), lang, state\.clarifyChrome\)/, "the tool reads the gaps from the draft it is about to confirm, in the chrome the agent supplied");
	assert.match(tools, /plan\.ask[\s\S]{0,600}?askClarifyQuestion\(/, "and asks before the human is shown anything");
	assert.match(tools, /markClarify\(state, caseKey\(goal\)/, "the round is marked on the goal itself, so an unchanged goal never asks again");
	assert.match(tools, /askGoalConfirm\(ctx, askGoal, askCases\)/, "the dialog receives the sharpened goal text and the sharpened cases");
	assert.match(tools, /state\.clarifyChrome = Object\.keys\(clarifyGiven\)\.length \? clarifyGiven : undefined/, "the clarify chrome is validated once and remembered on the run");
	assert.match(readFileSync(join(here, "extensions/finisher/src/gui.ts"), "utf8"), /askClarifyQuestion/, "and the session really provides the question dialog, not a stub");
});

test("a session with no dialog refuses the goal instead of waiting on a clarify question", async () => {
	const harness = liveHarness();
	const result = await harness.run("goal", { goal: "make it better", cases: [], lang: "en" });
	assert.equal(result.details.outcome, "unavailable", "no UI means no dialog, and no invented confirmation");
	assert.match(result.content[0].text, /no dialog/, "the refusal says why");
});

test("no intake counter is left in the wiring: the retired gate cannot come back through a hook", () => {
	const index = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	assert.ok(!index.includes("intakeGate"), "the gate that refused exploration is gone from the entry point");
	assert.ok(!index.includes("preGoalCalls"), "and so is the counter it spent");
	assert.match(index, /turnIntent\(mode\)/, "the turn's intent comes from the configured mode, not from the human's words");
	const types = readFileSync(join(here, "extensions/finisher/src/types.ts"), "utf8");
	assert.ok(!types.includes("preGoalCalls"), "the state carries no pre-goal budget either");
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
	assert.match(dialog, /npm test/, "the result the human picked reaches the dialog as a case the harness can check");

	const quiet = [];
	const sharp = await liveHarness(humanUi(quiet)).run("goal", { goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"], lang: "en" });
	assert.equal(sharp.isError, undefined);
	assert.equal(quiet.length, 1, "a goal that is already specific goes straight to the confirm dialog, asking nothing");
	assert.match(quiet[0], /src\/hud\.ts/, "and that dialog shows the goal it was given");
});
