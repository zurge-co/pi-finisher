import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIRM_TIMEOUT_MS, GOAL_TOO_MANY_CASES, goalConfirmLines, readConfirmTimeout, resetCycleState } from "../extensions/finisher/index.ts";
import { askGoalConfirmation, goalLineColor } from "../extensions/finisher/src/goal-dialog.ts";
import { registerTools } from "../extensions/finisher/src/tools.ts";
import { createStateBox } from "../extensions/finisher/index.ts";

const theme = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s };
const ctxWith = (outcome) => ({ hasUI: true, mode: "tui", cwd: process.cwd(), ui: { confirm: async () => outcome === "confirmed", notify: () => {} } });

const fakeCustom = (inputs, onRender) => (_ctx, _overlay, factory, _canPeek) =>
	new Promise((resolve) => {
		const tui = { requestRender: () => {}, terminal: { columns: 100, rows: 40 } };
		const component = factory(tui, theme, () => "", (v) => resolve(v));
		if (onRender) onRender(component);
		for (const key of inputs) component.handleInput(key);
	});

test("the dialog shows the goal and every case it is asking about, in the order they were confirmed", () => {
	const cases = ["A holds", "B holds", "C holds"];
	const lines = goalConfirmLines("ship the swarm", cases);
	const text = lines.map((l) => l.text).join("\n");
	assert.match(text, /ship the swarm/);
	const shown = lines.filter((l) => l.kind === "case").map((l) => l.text);
	assert.deepEqual(shown, ["1. A holds", "2. B holds", "3. C holds"], "a case may never be dropped or reordered on the way to the human");
	assert.match(text, /no further approval/, "the human must read what confirming means before confirming");
});

test("every case is shown, for any length: the human is asked about nothing they cannot see", () => {
	for (const n of [0, 1, GOAL_TOO_MANY_CASES, 50, 200]) {
		const cases = Array.from({ length: n }, (_, i) => `case ${i + 1}`);
		const shown = goalConfirmLines("g", cases).filter((l) => l.kind === "case");
		assert.deepEqual(shown.map((l) => l.text), cases.map((c, i) => `${i + 1}. ${c}`), `${n} cases: every one, in order, no cap and no hidden tail`);
	}
	assert.equal(goalConfirmLines("   ", []).find((l) => l.kind === "goal").text, "(no goal stated)", "an empty goal is named, never blank");
	for (const kind of ["goal", "blank", "header", "case", "note"]) assert.equal(typeof goalLineColor(kind), "string", `${kind} must have a colour, or the palette lookup throws in render`);
});

test("every key path out of the overlay ends the dialog with an answer — it can never hang or return nothing", async () => {
	for (const [keys, want] of [[["y"], "confirmed"], [["\r"], "confirmed"], [["n"], "declined"], [["\x1b"], "declined"]]) {
		const custom = fakeCustom(keys);
		assert.equal(await askGoalConfirmation({ ctx: ctxWith(true), custom }, "g", ["c"]), want, `keys ${JSON.stringify(keys)}`);
	}
	const closed = fakeCustom([], (component) => component.handleInput("\x1b"));
	assert.equal(await askGoalConfirmation({ ctx: ctxWith(true), custom: closed }, "g", []), "declined", "a dialog that closes without an answer is not a yes");
	const noDialog = { hasUI: true, mode: "print", cwd: process.cwd(), ui: { confirm: async () => true, notify: () => {} } };
	assert.equal(await askGoalConfirmation({ ctx: noDialog, custom: fakeCustom(["y"]) }, "g", []), "confirmed", "a non-TUI session still gets asked, through the plain confirm");
});

test("the overlay is what the human reads: it renders the goal, the cases and the keys, at any width", async () => {
	const rendered = [];
	const custom = (_ctx, _overlay, factory, _canPeek) =>
		new Promise((resolve) => {
			const tui = { requestRender: () => {}, terminal: { columns: 100, rows: 40 } };
			const done = (v) => resolve(v);
			const component = factory(tui, theme, () => "", done);
			for (const w of [8, 12, 16, 24, 40, 60, 120]) {
				const lines = component.render(w);
				rendered.push({ w, lines });
				for (const line of lines) assert.ok(visibleWidth(line) <= w, `width ${w}: "${line}" is ${visibleWidth(line)} columns wide`);
			}
			component.handleInput("y");
		});
	assert.equal(await askGoalConfirmation({ ctx: ctxWith(true), custom }, "make it prove itself", ["A holds", "B holds"]), "confirmed");
	const text = rendered[rendered.length - 1].lines.join("\n");
	assert.match(text, /make it prove itself/);
	assert.match(text, /A holds/);
	assert.match(text, /B holds/);
	assert.match(text, /enter = confirm/);
});

const humanCtx = (dir, extra = {}) => {
	const humanLog = { turns: 0 };
	const ctx = {
		cwd: dir,
		hasUI: true,
		mode: "tui",
		ui: { notify: () => {} },
		sessionManager: { getEntries: () => Array.from({ length: humanLog.turns }, () => ({ type: "message", message: { role: "user" } })), getSessionId: () => "session-1" },
		...extra,
	};
	return { ctx, humanLog };
};

const goalSession = (outcome, asked = []) => {
	const defs = [];
	const box = createStateBox({ phase: "requirements", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return box.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal, cases) => {
			asked.push({ goal, cases });
			return outcome;
		},
	});
	const { ctx, humanLog } = humanCtx(mkdtempSync(join(tmpdir(), "finisher-goal-")));
	const def = defs.find((d) => d.name === "finisher_goal");
	return { box, humanLog, run: (params) => def.execute("c1", params, undefined, undefined, ctx) };
};

const goalRun = async (outcome, params, asked = []) => {
	const session = goalSession(outcome, asked);
	return { result: await session.run(params), box: session.box };
};

test("a declined goal starts nothing, and a confirmed one starts the run — the dialog is the gate", async () => {
	const params = { goal: "ship the confirm dialog", cases: ["it asks once"] };

	const declined = await goalRun("declined", params);
	assert.equal(declined.result.isError, true);
	assert.match(declined.result.content[0].text, /NOT confirmed/);
	assert.equal(declined.box.get().goalDriver, undefined, "no confirmation means no run: the driver must not be armed");

	const headless = await goalRun("unavailable", params);
	assert.equal(headless.result.isError, true);
	assert.match(headless.result.content[0].text, /no dialog to ask in/);
	assert.equal(headless.box.get().goalDriver, undefined, "without a dialog the agent must not self-confirm");

	const confirmed = await goalRun("confirmed", params);
	assert.equal(confirmed.result.isError, undefined);
	assert.equal(confirmed.box.get().goalDriver.goal, params.goal);
	assert.match(confirmed.result.content[0].text, /goal confirmed once/);
});

test("a picked goal is still shown to the human in full, so the details can never be skipped", async () => {
	const seen = [];
	const ctx = { hasUI: true, mode: "print", cwd: process.cwd(), ui: { confirm: async (title, message) => (seen.push({ title, message }), true), notify: () => {} } };
	assert.equal(await askGoalConfirmation({ ctx, custom: fakeCustom(["n"]) }, "the goal text", ["case one", "case two"]), "confirmed");
	assert.match(seen[0].message, /the goal text/);
	assert.match(seen[0].message, /case one/);
	assert.match(seen[0].message, /case two/);
});

test("the dialog is asked once per goal, and an unchanged goal is never asked again", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	const params = { goal: "goal one", cases: ["a"] };
	await session.run(params);
	await session.run(params);
	assert.deepEqual(asked.map((a) => a.goal), ["goal one"], "an open goal is not re-asked on every round");
	assert.deepEqual(asked[0].cases, ["a"], "the human confirms the cases the agent proposed, not a rewritten list");

	await session.run({ goal: "  GOAL   one ", cases: ["a", "b"] });
	assert.deepEqual(asked.map((a) => a.goal), ["goal one"], "a changed case list is the agent's own plan: it never reopens the dialog");
	assert.deepEqual(session.box.get().goalDriver.cases, ["a", "b"], "and the new list does become the run's proof plan");

	session.box.get().goalDriver = { goal: "goal one", confirmedAt: 1, attempts: { rounds: 1 }, cases: ["a"], doneAt: 5, outcome: "needs-human" };
	const reopened = await session.run(params);
	assert.deepEqual(asked.map((a) => a.goal), ["goal one"], "a goal closed by a verify round is the SAME goal: it resumes instead of asking the human again");
	assert.equal(reopened.isError, undefined);
	assert.equal(session.box.get().goalDriver.doneAt, undefined, "reopened, not restarted");
	assert.equal(session.box.get().goalDriver.confirmedAt, 1, "the human's confirmation is kept, not re-stamped");
	assert.match(reopened.content[0].text, /unchanged/, "and the agent is told the goal was not re-confirmed");

	session.box.get().goalDriver = { goal: "goal one", confirmedAt: 1, attempts: { rounds: 1 }, cases: ["a"], doneAt: 5, outcome: "verified" };
	const verified = await session.run(params);
	assert.deepEqual(asked.map((a) => a.goal), ["goal one"], "a verified goal is never reopened behind the human's back");
	assert.equal(verified.details.outcome, "already-verified");
	assert.equal(session.box.get().goalDriver.doneAt, 5, "it stays closed");
});

test("an unreadably long case list is refused before anyone is asked, instead of a dialog nobody can weigh", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	const many = Array.from({ length: GOAL_TOO_MANY_CASES + 1 }, (_, i) => `case ${i + 1}`);
	const refused = await session.run({ goal: "g", cases: many });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /too many/);
	assert.deepEqual(asked, [], "nothing is put to the human if it cannot be shown honestly");
	assert.equal(session.box.get().goalDriver, undefined, "and nothing runs");

	const atLimit = await session.run({ goal: "g", cases: many.slice(1) });
	assert.deepEqual(asked[0].cases.length, GOAL_TOO_MANY_CASES, "the boundary itself is allowed and shown in full");
	assert.equal(atLimit.isError, undefined);
});

const swarmSession = () => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const asked = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return box.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "coders ran" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal) => {
			asked.push(goal);
			return "confirmed";
		},
		launchSubagent: async (_ctx, role) => {
			box.get().subagentRuns.push({ role, ok: true, summary: "", at: Date.now(), status: "done", logPath: "/tmp/x.log" });
			return { ok: true, output: "done", logPath: "/tmp/x.log", calls: [] };
		},
	});
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-swarm-")), model: { provider: "p", id: "m" }, hasUI: true, mode: "tui", ui: { notify: () => {} } };
	return { asked, box, ctx, run: (name, params) => defs.find((d) => d.name === name).execute("c1", params, undefined, undefined, ctx) };
};

test("verify NEVER manufactures a confirmed goal, so the dialog cannot be bypassed by verifying first", async () => {
	const s = swarmSession();
	const verify = await s.run("finisher_verify", { goal: "a goal the human never confirmed", skipDeterministic: true, cases: [{ id: "a goal the human never confirmed", command: "npm test" }] });
	assert.match(verify.content[0].text, /no goal was confirmed/, "an unconfirmed verify must say so instead of claiming a goal");
	assert.equal(s.box.get().goalDriver, undefined, "no goal driver may be armed by a verify run");

	const after = await s.run("finisher_goal", { goal: "a goal the human never confirmed", cases: ["v1 holds"] });
	assert.deepEqual(s.asked, ["a goal the human never confirmed"], "the very next finisher_goal must still put the dialog in front of the human");
	assert.match(after.content[0].text, /goal confirmed once/, "and only then does the goal start");
	assert.equal(s.box.get().goalDriver.goal, "a goal the human never confirmed");
});

test("an unconfirmed verify reports its evidence honestly: a proven case is not an error, an unproven one is", async () => {
	const proven = swarmSession();
	proven.box.get().verifyCalls = [{ command: "npm test", ok: true }];
	const pass = await proven.run("finisher_verify", { goal: "g", skipDeterministic: true, cases: [{ id: "g", command: "npm test" }] });
	assert.equal(pass.isError, undefined, "a proven case is not an error just because no goal was confirmed");
	const unproven = swarmSession();
	const fail = await unproven.run("finisher_verify", { goal: "g", skipDeterministic: true, cases: [] });
	assert.equal(fail.isError, true, "a case with no named command is not proven, and that is not a pass");
	assert.match(fail.content[0].text, /UNVERIFIED/);
});

test("the verify gate keys on an OPEN goal, not on a cold session: a live goal keeps its rounds, and a closed one never arms a new goal", async () => {
	const live = swarmSession();
	await live.run("finisher_goal", { goal: "the live goal", cases: ["v1 holds"] });
	const before = live.box.get().goalDriver;
	for (let i = 0; i < 3; i++) await live.run("finisher_verify", { skipDeterministic: true, cases: [{ id: "v1 holds", command: "npm test" }] });
	const after = live.box.get().goalDriver;
	assert.ok(after.attempts.rounds > before.attempts.rounds || after.doneAt, "a verify of a confirmed live goal must book its evidence, not be shrugged off as unconfirmed");
	assert.equal(after.goal, "the live goal", "the live goal's text is never replaced by the agent's verify wording");
	assert.equal(after.confirmedAt, before.confirmedAt, "the human's confirmation is not re-stamped by a verify run");

	const closed = swarmSession();
	closed.box.get().goalDriver = { goal: "already done", confirmedAt: 1, attempts: { rounds: 1 }, doneAt: 5, outcome: "verified" };
	await closed.run("finisher_verify", { goal: "a goal nobody confirmed", skipDeterministic: true, cases: [{ id: "v1", command: "npm test" }] });
	assert.equal(closed.box.get().goalDriver.goal, "already done", "a verify after a closed goal must never arm a new goal from its own wording");
	assert.equal(closed.box.get().goalDriver.doneAt, 5, "and it must leave the closed goal closed");
	assert.deepEqual(closed.asked, [], "the dialog is not the issue — nothing may be armed at all");
});

test("the goal can only change through the dialog, while its cases are the agent's own plan", async () => {
	const asked = [];
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	let answer = "confirmed";
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() { return box.get(); },
		persist: () => {},
		updateWidget: () => {},
		askGoalConfirm: async (_ctx, goal, cases) => (asked.push({ goal, cases }), answer),
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const { ctx, humanLog } = humanCtx(mkdtempSync(join(tmpdir(), "finisher-goal-")), { model: { provider: "p", id: "m" } });
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);

	await run("finisher_goal", { goal: "ship the race HUD", cases: ["the lap clock ticks", "the pit split is exact"] });
	assert.equal(asked.length, 1, "the first goal is confirmed by the human");
	assert.deepEqual(box.get().goalDriver.cases, ["the lap clock ticks", "the pit split is exact"], "the confirmed cases are kept on the driver");

	await run("finisher_goal", { goal: "ship the race HUD", cases: ["the lap clock ticks", "the pit split is exact"] });
	assert.equal(asked.length, 1, "the same goal with the same cases resumes without bothering the human");

	await run("finisher_goal", { goal: "ship the race HUD", cases: ["the lap clock ticks", "and it looks nice"] });
	assert.equal(asked.length, 1, "a changed case list is the agent's proof plan, not the human's decision — no dialog");
	assert.deepEqual(box.get().goalDriver.cases, ["the lap clock ticks", "and it looks nice"], "and it becomes the run's proof plan");

	const before = JSON.stringify(box.get().goalDriver);
	answer = "declined";
	const changedGoal = await run("finisher_goal", { goal: "ship something else entirely", cases: ["c1"] });
	assert.equal(asked.length, 2, "a DIFFERENT goal still goes to the human");
	assert.equal(changedGoal.isError, true, "a declined goal is refused");
	assert.equal(changedGoal.details.outcome, "declined");
	assert.equal(JSON.stringify(box.get().goalDriver), before, "a declined goal leaves the confirmed one byte-identical");

	humanLog.turns += 1;
	answer = "unavailable";
	const noUi = await run("finisher_goal", { goal: "ship something else entirely", cases: ["c1"] });
	assert.equal(noUi.isError, true, "no dialog means no change — never a silent rewrite");
	assert.equal(JSON.stringify(box.get().goalDriver), before, "and the goal is untouched");

	humanLog.turns += 1;
	answer = "confirmed";
	await run("finisher_goal", { goal: "ship something else entirely", cases: ["c1"] });
	assert.equal(box.get().goalDriver.goal, "ship something else entirely", "a confirmed new goal replaces the old one");
});

test("a verify run can never name, rename or re-case the goal it verifies", async () => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const defs = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() { return box.get(); },
		persist: () => {},
		updateWidget: () => {},
		askGoalConfirm: async () => "confirmed",
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async (_ctx, role) => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [{ command: "node x.mjs", ok: true }], ...(role === "verifier" ? { result: { result: "PASS", why: "it holds" } } : {}) }),
	});
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-verify-")), model: { provider: "p", id: "m" }, hasUI: true, mode: "tui", ui: { notify: () => {} } };
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);
	await run("finisher_goal", { goal: "the human's goal", cases: ["case one"] });
	const before = JSON.stringify(box.get().goalDriver);
	box.get().verifyCalls = [{ command: "npm test", ok: true }];
	await run("finisher_verify", { goal: "a completely different goal the agent invented", skipDeterministic: true, cases: [{ id: "case one", command: "npm test" }] });
	const after = box.get().goalDriver;
	assert.equal(after.goal, "the human's goal", "the goal text is never taken from the verify call");
	assert.deepEqual(after.cases, ["case one"], "nor its case list");
	assert.equal(after.confirmedAt, JSON.parse(before).confirmedAt, "the confirmation is not re-stamped");
});

test("an open plan is never replaced behind the human's back", async () => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const defs = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() { return box.get(); },
		persist: () => {},
		updateWidget: () => {},
		askGoalConfirm: async () => "confirmed",
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-plan-")), model: { provider: "p", id: "m" }, hasUI: true, mode: "tui", ui: { notify: () => {} } };
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);
	await run("finisher_goal", { goal: "g", cases: ["c1"] });
	await run("finisher_phase", { plan: ["read it", "change it"] });
	await run("finisher_phase", { done: true });
	const before = JSON.stringify(box.get().goalDriver);
	const replaced = await run("finisher_phase", { plan: ["something else entirely"] });
	assert.equal(replaced.details.action, "blocked", "a second plan is refused while laps are open");
	assert.equal(JSON.stringify(box.get().goalDriver), before, "so the laps and the time already spent are untouched");
});

test("a dialog nobody answers times out into a refusal, never into a started goal", async () => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const notes = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() { return box.get(); },
		persist: () => {},
		updateWidget: () => {},
		escalate: (kind, detail) => box.get().escalations.push({ kind, detail, at: Date.now() }),
		askGoalConfirm: async () => "timeout",
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const { ctx, humanLog } = humanCtx(mkdtempSync(join(tmpdir(), "finisher-timeout-")), { model: { provider: "p", id: "m" }, ui: { notify: (text) => notes.push(text) } });
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);

	const first = await run("finisher_goal", { goal: "a goal nobody answered", cases: ["c1"] });
	assert.equal(first.isError, true, "a timeout is a refusal");
	assert.equal(box.get().goalDriver, undefined, "and the goal is never started on a timeout");
	assert.match(first.content[0].text, /nobody answered the goal dialog/, "the agent is told why");
	assert.match(first.content[0].text, /STOP here/, "and that the run is stopped, not paused for a new guess");
	assert.match(first.content[0].text, /resumes when the human asks for it again/, "only a human message resumes it");
	assert.equal(notes.length, 1, "the human is complained at, not silently ignored");
	assert.match(notes[0], /nothing was started/);
	assert.deepEqual(box.get().escalations.map((e) => e.kind), ["goal-confirm-timeout"], "the report will mention it too");
	assert.equal(box.get().goalConsent?.reason, "timeout", "the refusal is recorded, so a retry cannot slip through");

	const retry = await run("finisher_goal", { goal: "a goal nobody answered", cases: ["c1"] });
	assert.equal(retry.isError, true, "the agent may not retry the dialog on its own");
	assert.equal(retry.details.outcome, "blocked-until-human");
	assert.equal(notes.length, 1, "and no second dialog is opened");

	humanLog.turns += 1;
	const afterHuman = await run("finisher_goal", { goal: "a goal the human now wants", cases: ["c1"] });
	assert.equal(afterHuman.details.outcome, "timeout", "once the human speaks again the dialog is offered again (and here times out a second time)");

	box.get().goalDriver = { goal: "the human's goal", confirmedAt: 1_000, attempts: { rounds: 0 }, cases: ["c1"] };
	humanLog.turns += 1;
	const before = JSON.stringify(box.get().goalDriver);
	const changedGoal = await run("finisher_goal", { goal: "a goal the human never confirmed", cases: ["c1", "c2"] });
	assert.equal(changedGoal.isError, true, "a timed-out new goal is refused too");
	assert.equal(JSON.stringify(box.get().goalDriver), before, "and leaves the confirmed goal byte-identical");
});

test("the timeout is configurable, and 0 means wait forever", async () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-cfg-"));
	mkdirSync(join(dir, ".finisher"), { recursive: true });
	writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ confirmTimeoutMs: 90_000 }));
	assert.equal(readConfirmTimeout(dir), 90_000);
	writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ confirmTimeoutMs: 0 }));
	assert.equal(readConfirmTimeout(dir), 0, "0 disables the timer instead of silently becoming the default");
	assert.equal(readConfirmTimeout(dir, { FINISHER_CONFIRM_TIMEOUT_MS: "5000" }), 5_000, "the env wins over the file");
	writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ confirmTimeoutMs: 5e12 }));
	assert.equal(readConfirmTimeout(dir), 2_147_483_647, "a value past the timer ceiling is clamped, never fired instantly");
	for (const junk of [{ confirmTimeoutMs: -1 }, { confirmTimeoutMs: "90s" }, { confirmTimeoutMs: null }, { confirmTimeoutMs: Number.NaN }]) {
		writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify(junk));
		assert.equal(readConfirmTimeout(dir), DEFAULT_CONFIRM_TIMEOUT_MS, `junk ${JSON.stringify(junk)} falls back`);
	}
	rmSync(join(dir, ".finisher", "config.json"));
	assert.equal(readConfirmTimeout(dir), DEFAULT_CONFIRM_TIMEOUT_MS, "no config at all keeps the default");
});

test("a refusal never outlives its own goal: a confirmed goal and a fresh cycle both clear it", async () => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [], goalConsent: { humanTurns: 0, reason: "timeout", sessionId: "session-1" } });
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() { return box.get(); },
		persist: () => {},
		updateWidget: () => {},
		escalate: () => {},
		askGoalConfirm: async () => "confirmed",
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const { ctx, humanLog } = humanCtx(mkdtempSync(join(tmpdir(), "finisher-consent-")), { model: { provider: "p", id: "m" } });
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);

	const blocked = await run("finisher_goal", { goal: "g", cases: ["c1"] });
	assert.equal(blocked.details.outcome, "blocked-until-human", "a refusal stops the run while the human is silent");

	humanLog.turns += 1;
	await run("finisher_goal", { goal: "g", cases: ["c1"] });
	assert.equal(box.get().goalConsent, undefined, "a confirmed goal clears the old refusal, so the next goal is not blocked by it");
	resetCycleState(box.get());
	assert.equal(box.get().goalConsent, undefined, "and a cycle reset cannot inherit one either");
});

test("a refusal blocks only the dialog it refused: a confirmed goal resumes, another session asks again", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	const refusal = (sessionId) => ({ humanTurns: 0, reason: "declined", sessionId });
	session.box.get().goalDriver = { goal: "goal one", confirmedAt: 1, attempts: { rounds: 1 }, cases: ["case a"] };
	session.box.get().goalConsent = refusal("session-1");

	const resumed = await session.run({ goal: "goal one" });
	assert.equal(resumed.isError, undefined, "declining some other goal must never stop the goal the human already confirmed");
	assert.equal(asked.length, 0, "and that resume asks nothing at all");
	assert.deepEqual(session.box.get().goalDriver.cases, ["case a"], "the run keeps the cases the human confirmed");
	assert.match(resumed.content[0].text, /1\. case a/, "the agent is shown the run's own cases, never a rewritten list");

	session.box.get().goalConsent = refusal("session-1");
	const other = await session.run({ goal: "goal two" });
	assert.equal(other.details.outcome, "blocked-until-human", "a NEW goal is a new dialog, so a refusal just before still stops it");
	assert.equal(asked.length, 0, "and the human is not nagged with it");

	const later = goalSession("confirmed", asked);
	later.box.get().goalConsent = refusal("session-0");
	const reopened = await later.run({ goal: "goal three" });
	assert.equal(reopened.isError, undefined, "a refusal recorded in another session can never lock the dialog shut");
	assert.equal(asked.length, 1, "the human is asked in the session they are actually in");
});

test("a goal the human cannot read is refused before the dialog, never shown to them", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	session.box.get().humanLang = "th";
	const blocked = await session.run({ goal: "ship the dialog in the human's language", cases: ["it asks once"] });
	assert.equal(blocked.isError, true, "an English goal for a Thai human is not confirmable");
	assert.equal(asked.length, 0, "the human is never asked to confirm a goal they cannot read");
	assert.equal(session.box.get().goalDriver, undefined, "nothing is armed by a refused goal");
	assert.match(blocked.content[0].text, /Thai/, "the refusal names the language the goal must be written in");

	const ok = await session.run({ goal: "ทำให้กล่องยืนยันเป็นภาษาไทย", cases: ["ถามครั้งเดียว"] });
	assert.equal(ok.isError, undefined, "the same goal written in Thai is confirmable");
	assert.equal(asked.length, 1);
	assert.equal(session.box.get().goalLang, "th", "the run remembers the language the human reads");
});

test("the declared language is what the dialog speaks, and the chrome it brings is validated", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	const params = { goal: "fazer o dialog falar a língua do humano", cases: ["pergunta uma vez"], lang: "PT-br", chrome: { header: "A meta está cumprida quando:", title: "▚ confirme uma vez" } };
	const result = await session.run(params);
	assert.equal(result.isError, undefined);
	assert.equal(session.box.get().goalLang, "pt-br", "the tag is normalised, and a Latin goal needs no script evidence to pass");
	assert.equal(session.box.get().goalChrome.header, "A meta está cumprida quando:", "the human's own words reach the dialog");
	assert.equal(session.box.get().goalChrome.keys, undefined, "nothing the agent did not supply is invented");

	const junk = goalSession("confirmed", []);
	await junk.run({ goal: "un altro goal latino", lang: "it", chrome: { header: "due\nrighe", note: "   " } });
	assert.equal(junk.box.get().goalLang, "it");
	assert.equal(junk.box.get().goalChrome, undefined, "a chrome that is not one readable line is dropped, not shown");
});
