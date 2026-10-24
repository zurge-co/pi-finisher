import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GOAL_TOO_MANY_CASES, goalConfirmLines } from "../extensions/finisher/index.ts";
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
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-goal-")), hasUI: true, mode: "tui", ui: { notify: () => {} } };
	const def = defs.find((d) => d.name === "finisher_goal");
	return { box, run: (params) => def.execute("c1", params, undefined, undefined, ctx) };
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

test("the dialog is asked whenever no goal is open: once per open goal, again after it closes", async () => {
	const asked = [];
	const session = goalSession("confirmed", asked);
	const params = { goal: "goal one", cases: ["a"] };
	await session.run(params);
	await session.run(params);
	assert.deepEqual(asked.map((a) => a.goal), ["goal one"], "an open goal is not re-asked on every round");
	assert.deepEqual(asked[0].cases, ["a"], "the human confirms the cases the agent proposed, not a rewritten list");

	session.box.get().goalDriver = { goal: "goal one", confirmedAt: 1, attempts: { rounds: 1 }, doneAt: 5, outcome: "verified" };
	await session.run(params);
	assert.deepEqual(asked.map((a) => a.goal), ["goal one", "goal one"], "a CLOSED goal is finished — reusing its confirmation would start new work on an old yes");
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

const swarmSession = (verifyOutput = "$ node -e run()\nexit code 0\nVERDICT: PASS") => {
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
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal) => {
			asked.push(goal);
			return "confirmed";
		},
		launchSubagent: async (_ctx, role) => {
			box.get().subagentRuns.push({ role, ok: true, summary: "", at: Date.now(), status: "done", logPath: "/tmp/x.log" });
			return { ok: true, output: verifyOutput, logPath: "/tmp/x.log" };
		},
	});
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-swarm-")), model: { provider: "p", id: "m" }, hasUI: true, mode: "tui", ui: { notify: () => {} } };
	return { asked, box, ctx, run: (name, params) => defs.find((d) => d.name === name).execute("c1", params, undefined, undefined, ctx) };
};

test("a verify fan-out NEVER manufactures a confirmed goal, so the dialog cannot be bypassed by verifying first", async () => {
	const s = swarmSession();
	const verify = await s.run("finisher_swarm", { mode: "verify", goal: "a goal the human never confirmed", subtasks: [{ id: "v1", instruction: "prove v1" }] });
	assert.match(verify.content[0].text, /no goal was confirmed/, "an unconfirmed verify must say so instead of claiming a goal");
	assert.equal(s.box.get().goalDriver, undefined, "no goal driver may be armed by a verify run");

	const after = await s.run("finisher_goal", { goal: "a goal the human never confirmed", cases: ["v1 holds"] });
	assert.deepEqual(s.asked, ["a goal the human never confirmed"], "the very next finisher_goal must still put the dialog in front of the human");
	assert.match(after.content[0].text, /goal confirmed once/, "and only then does the goal start");
	assert.equal(s.box.get().goalDriver.goal, "a goal the human never confirmed");
});

test("an unconfirmed verify still reports its evidence honestly: passes are not failures, and no round is booked", async () => {
	const pass = await swarmSession().run("finisher_swarm", { mode: "verify", goal: "g", subtasks: [{ id: "v1", instruction: "p" }] });
	assert.equal(pass.isError, undefined, "a passing verify is not an error just because no goal was confirmed");
	const fail = await swarmSession("$ false\nexit code 1\nVERDICT: FAIL").run("finisher_swarm", { mode: "verify", goal: "g", subtasks: [{ id: "v1", instruction: "p" }] });
	assert.equal(fail.isError, true, "a failing verify is still reported as a failure");
	assert.match(fail.content[0].text, /Fix the real cause/);
});

test("the verify gate keys on an OPEN goal, not on a cold session: a live goal keeps its rounds, and a closed one never arms a new goal", async () => {
	const live = swarmSession();
	await live.run("finisher_goal", { goal: "the live goal", cases: ["v1 holds"] });
	const before = live.box.get().goalDriver;
	for (let i = 0; i < 3; i++) await live.run("finisher_swarm", { mode: "verify", goal: "the live goal", subtasks: [{ id: "v1", instruction: "p" }] });
	const after = live.box.get().goalDriver;
	assert.ok(after.attempts.rounds > before.attempts.rounds || after.doneAt, "a verify of a confirmed live goal must book its evidence, not be shrugged off as unconfirmed");
	assert.equal(after.goal, "the live goal", "the live goal's text is never replaced by the agent's verify wording");
	assert.equal(after.confirmedAt, before.confirmedAt, "the human's confirmation is not re-stamped by a verify run");

	const closed = swarmSession();
	closed.box.get().goalDriver = { goal: "already done", confirmedAt: 1, attempts: { rounds: 1 }, doneAt: 5, outcome: "verified" };
	await closed.run("finisher_swarm", { mode: "verify", goal: "a goal nobody confirmed", subtasks: [{ id: "v1", instruction: "p" }] });
	assert.equal(closed.box.get().goalDriver.goal, "already done", "a verify after a closed goal must never arm a new goal from its own wording");
	assert.equal(closed.box.get().goalDriver.doneAt, 5, "and it must leave the closed goal closed");
	assert.deepEqual(closed.asked, [], "the dialog is not the issue — nothing may be armed at all");
});
