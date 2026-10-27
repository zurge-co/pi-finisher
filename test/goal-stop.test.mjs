import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armGoalStop,
	claimGoalStopAbort,
	clearGoalStop,
	goalStopGate,
	goalStopHeadline,
	goalStopMessage,
	goalStopOf,
	takeGoalStop,
} from "../extensions/finisher/index.ts";

const BASE = { phase: "requirements", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] };

const tmpRepo = (config) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-goal-stop-"));
	mkdirSync(join(dir, ".finisher"), { recursive: true });
	if (config) writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify(config));
	return dir;
};

const loadHarness = async () => {
	const ext = (await import("../extensions/finisher/index.ts")).default;
	const hooks = new Map();
	const tools = new Map();
	const written = [];
	const pi = {
		on: (name, fn) => {
			hooks.set(name, [...(hooks.get(name) ?? []), fn]);
			return () => {};
		},
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerVirtualModel: () => {},
		appendEntry: (type, data) => written.push({ type, data }),
	};
	const saved = process.env.PI_FINISHER_SUBAGENT;
	process.env.PI_FINISHER_SUBAGENT = "0";
	try {
		ext(pi);
	} finally {
		if (saved === undefined) delete process.env.PI_FINISHER_SUBAGENT;
		else process.env.PI_FINISHER_SUBAGENT = saved;
	}
	return { hooks, tools, state: () => written[written.length - 1]?.data };
};

const fire = async (hooks, name, event, ctx) => {
	const out = [];
	for (const h of hooks.get(name) ?? []) out.push(await h(event, ctx));
	return out;
};

const session = (cwd, confirm) => {
	const aborts = [];
	const notices = [];
	const ctx = {
		cwd,
		mode: "print",
		hasUI: true,
		abort: () => aborts.push(Date.now()),
		ui: { confirm, notify: (text) => notices.push(text), setWidget: () => {}, setWorkingIndicator: () => {}, setWorkingMessage: () => {} },
		sessionManager: { getEntries: () => [{ type: "custom", customType: "finisher-state", data: { ...BASE } }], getSessionId: () => "session-1" },
	};
	return { ctx, aborts, notices };
};

const toolCall = (hooks, ctx, name = "bash", input = { command: "ls" }) =>
	fire(hooks, "tool_call", { type: "tool_call", toolName: name, toolCallId: "t1", input }, ctx);

const turnEnd = (hooks, ctx) =>
	fire(hooks, "turn_end", { type: "turn_end", turnIndex: 1, outcome: "completed", message: { role: "assistant" }, toolResults: [], entries: [], continue: false, context: { contextEntries: [] } }, ctx);

const userMessage = (hooks, ctx, prompt = "another goal") =>
	fire(hooks, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "you are a coding agent" }, ctx);

const blocked = (answers) => answers.find((a) => a?.block);

test("a refused dialog blocks EVERY tool call, and the block reason is one line the human can read", () => {
	for (const reason of ["declined", "timeout"]) {
		for (const lang of ["th", "en"]) {
			const host = {};
			const stop = armGoalStop(host, reason, 120, 1_000);
			const gate = goalStopGate(host, lang);
			assert.deepEqual(gate, { block: true, terminate: true, reason: goalStopHeadline(stop, lang) }, `${reason}/${lang}: the gate blocks and terminates`);
			assert.ok(!gate.reason.includes("\n"), `${reason}/${lang}: a block reason is one line, never the whole two-line message`);
			assert.notEqual(gate.reason, "", `${reason}/${lang}: a silent block would look like a broken tool`);
			assert.ok(goalStopGate(host, lang), `${reason}/${lang}: a blocked call never spends the refusal — every later call is blocked too`);
		}
	}
	assert.equal(goalStopGate({}), undefined, "no refusal means no gate at all");
	assert.equal(goalStopGate(undefined), undefined, "an absent host is not a refusal");
});

test("the message names what stopped the run and echoes the deadline it actually waited — in the human's language", () => {
	for (const lang of ["th", "en"]) {
		const declined = goalStopMessage({ reason: "declined", seconds: 120 }, lang);
		assert.ok(!declined.includes("120"), `${lang}: a declined dialog waited for nobody, so it quotes no deadline`);
		const timedOut = goalStopMessage({ reason: "timeout", seconds: 120 }, lang);
		assert.match(timedOut, /120/, `${lang}: the timeout must say how long it waited`);
		for (const text of [declined, timedOut]) {
			assert.ok(text.includes("\n"), `${lang}: the message says what happened and what unblocks it`);
			assert.match(text, /stop|หยุด/i, `${lang}: the run is reported as stopped`);
		}
		for (const seconds of [0, 0.4, 119.6, -5, Number.NaN, Number.POSITIVE_INFINITY])
			assert.match(goalStopMessage({ reason: "timeout", seconds }, lang), /within \d+s|ภายใน \d+ วินาที/, `${lang}: a nonsense deadline still prints a real number (${seconds})`);
	}
	assert.match(goalStopMessage({ reason: "declined", seconds: 1 }, "th"), /[\u0E00-\u0E7F]/, "a Thai human reads Thai");
	assert.ok(!/[\u0E00-\u0E7F]/.test(goalStopMessage({ reason: "declined", seconds: 1 }, "en")), "an English human reads English");
});

test("claiming the abort is one-shot, and claiming never lifts the stop", () => {
	const host = {};
	assert.equal(claimGoalStopAbort(host), undefined, "nothing armed, nothing to abort");
	const first = armGoalStop(host, "timeout", 120);
	assert.equal(claimGoalStopAbort(host), first, "the first claim owns the abort");
	assert.equal(claimGoalStopAbort(host), undefined, "the second claim is refused, so no double abort");
	assert.equal(goalStopOf(host), first, "claiming never silently lifts the stop");
	const second = armGoalStop(host, "declined", 0);
	assert.notEqual(second, first);
	assert.equal(claimGoalStopAbort(host), second, "a fresh refusal is a fresh stop, with its own abort");
	assert.equal(clearGoalStop(host), true);
	assert.equal(goalStopOf(host), undefined);
	assert.equal(clearGoalStop(host), false, "clearing twice reports nothing was left to clear");
	assert.equal(takeGoalStop({}), undefined);
});

const goalAttempt = async (outcome, config, params = { goal: "ship the stop", cases: ["it stops"] }) => {
	const harness = await loadHarness();
	const answer = { yes: outcome === "confirmed" };
	const { ctx, aborts, notices } = session(tmpRepo(config), outcome === "timeout" ? () => new Promise(() => {}) : async () => answer.yes);
	await fire(harness.hooks, "session_start", {}, ctx);
	const goal = harness.tools.get("goal");
	assert.ok(goal, "goal must be registered by the harness itself, not by this test");
	const result = await goal.execute("c1", params, undefined, undefined, ctx);
	return { ...harness, ctx, aborts, notices, result, answer };
};

test("a declined goal is armed on the state, every later tool call is blocked, the turn aborts once, and only a new human message lifts it", async () => {
	const run = await goalAttempt("declined");
	assert.equal(run.result.isError, true);
	assert.equal(run.result.terminate, true, "the agent is not allowed to think on after a refusal");
	assert.equal(run.state().goalDriver, undefined, "a refusal starts nothing");
	const stop = goalStopOf(run.state());
	assert.ok(stop, "the refusal is on the state, so a fresh turn cannot lose it");
	assert.equal(stop.reason, "declined");
	assert.ok(run.result.content[0].text.includes(goalStopHeadline(stop)), "the agent is told exactly what the human is");
	assert.match(run.result.content[0].text, /declined|NOT confirmed/, "and it is told the human said no");

	for (const name of ["bash", "edit", "verify", "code"])
		assert.equal(blocked(await toolCall(run.hooks, run.ctx, name))?.terminate, true, `${name} is blocked after the refusal`);

	await turnEnd(run.hooks, run.ctx);
	await turnEnd(run.hooks, run.ctx);
	await turnEnd(run.hooks, run.ctx);
	assert.equal(run.aborts.length, 1, "the run is aborted once — a second abort on the same refusal is a loop");
	assert.equal(goalStopOf(run.state())?.aborted, true, "the abort is spent on the stop, so it cannot fire twice");
	assert.ok(blocked(await toolCall(run.hooks, run.ctx)), "and the stop stays armed after the abort");

	await userMessage(run.hooks, run.ctx, "another goal please");
	assert.equal(goalStopOf(run.state()), undefined, "a new human message is what lifts the stop");
	assert.equal(blocked(await toolCall(run.hooks, run.ctx)), undefined, "and tools work again");
	await turnEnd(run.hooks, run.ctx);
	assert.equal(run.aborts.length, 1, "a lifted stop never aborts a live turn");

	run.answer.yes = true;
	const again = await run.tools.get("goal").execute("c2", { goal: "ship the stop", cases: ["it stops"] }, undefined, undefined, run.ctx);
	assert.notEqual(again.isError, true, "after the new message the human is asked again, not stonewalled");
	assert.equal(run.state().goalDriver?.goal, "ship the stop", "and a yes on that new dialog really starts the work");
	assert.equal(goalStopOf(run.state()), undefined, "a fresh confirmation arms no stop");
});

test("a dialog nobody answers stops the run exactly like a decline, quoting the deadline it waited", async () => {
	const run = await goalAttempt("timeout", { confirmTimeoutMs: 1000 });
	const stop = goalStopOf(run.state());
	assert.ok(stop, "a timeout is a refusal: nothing may be started after it");
	assert.equal(stop.reason, "timeout");
	assert.equal(stop.seconds, 1, "the stop carries the deadline the human did not meet");
	assert.equal(run.result.terminate, true);
	assert.equal(run.state().goalDriver, undefined, "a timeout starts nothing");
	assert.match(run.result.content[0].text, /within 1s|ภายใน 1 วินาที/, "the agent quotes the same deadline the human was given");
	assert.ok(blocked(await toolCall(run.hooks, run.ctx)), "and the next tool call is blocked");
});

test("a confirmed goal is never stopped: tools pass, the turn is not aborted, and no stop is left behind", async () => {
	const run = await goalAttempt("confirmed");
	const state = run.state();
	assert.equal(state.goalDriver?.goal, "ship the stop", "the goal really was confirmed");
	assert.equal(goalStopOf(state), undefined, "a yes arms no stop");
	for (const name of ["bash", "edit", "verify"]) assert.equal(blocked(await toolCall(run.hooks, run.ctx, name)), undefined, `${name} runs on a confirmed goal`);
	await turnEnd(run.hooks, run.ctx);
	assert.equal(run.aborts.length, 0, "a confirmed goal keeps running");
});

test("the human is told exactly once, in their own language, that nothing started and a new message resumes", async () => {
	const thai = await goalAttempt("declined", undefined, { goal: "หยุดรันทันทีเมื่อไม่ยืนยันกล่อง", lang: "th" });
	assert.equal(thai.notices.length, 1, "one refusal is one message — an escalation notice on top would tell the human twice");
	const seen = thai.notices[0];
	assert.match(seen, /[\u0E00-\u0E7F]/, "a Thai human reads Thai, not the English fallback");
	assert.match(seen, /ไม่มีอะไรถูกเริ่ม/, "the message says nothing was started");
	assert.match(seen, /พิมพ์ข้อความใหม่/, "and that a new message is what resumes the work");
	assert.ok(thai.result.content[0].text.includes(seen), "the agent is handed the very text the human saw, so the report cannot drift from it");

	const en = await goalAttempt("timeout", { confirmTimeoutMs: 1000 });
	assert.equal(en.notices.length, 1, "a timeout is told once too");
	assert.ok(!/[\u0E00-\u0E7F]/.test(en.notices[0]), "an English human is never handed the Thai text");
	assert.match(en.notices[0], /nothing was started|nothing has started/i, "the timeout message says the same thing the decline does: nothing started");
});
