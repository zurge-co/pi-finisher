import "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GOAL_QUEUE_MAX, advanceGoalQueue, createStateBox, enqueueGoal, goalPromotedNote, goalQueueFullNote, goalQueuedNote, goalQueueRefusedNote, queueIndexOf } from "../extensions/finisher/index.ts";
import { registerTools } from "../extensions/finisher/src/tools.ts";

const entry = (goal, cases = []) => ({ goal, cases, queuedAt: 1 });

test("the queue is FIFO: every goal is promoted in the exact order it entered, each as a fresh run", () => {
	const goals = ["alpha", "beta", "gamma", "delta"];
	let queue = [];
	for (const goal of goals) queue = enqueueGoal(queue, entry(goal)).queue;
	const state = { goalDriver: { goal: "running", confirmedAt: 0, attempts: { rounds: 3, fingerprints: [], caseRounds: {} }, doneAt: 7 }, goalQueue: queue };
	const seen = [];
	for (let at = 10; ; at += 10) {
		const next = advanceGoalQueue(state, at);
		if (!next) break;
		seen.push(state.goalDriver.goal);
		assert.equal(state.goalDriver.doneAt, undefined, "a promoted goal is open, never born closed");
		assert.equal(state.goalDriver.attempts.rounds, 0, "a promoted goal starts with fresh attempts, not the old run's");
		assert.equal(state.goalDriver.confirmedAt, at);
	}
	assert.deepEqual(seen, goals);
	assert.equal(state.goalQueue, undefined, "the queue field clears once it drains");
});

test("re-queueing the same goal never duplicates it: cases refresh in place and the order holds", () => {
	let queue = [];
	queue = enqueueGoal(queue, entry("one", ["c1"])).queue;
	queue = enqueueGoal(queue, entry("two", ["t1"])).queue;
	const again = enqueueGoal(queue, entry("  ONE  ", ["c2"]));
	assert.equal(again.ok, true);
	assert.equal(again.position, 1);
	assert.equal(again.queue.length, 2);
	assert.deepEqual(again.queue[0].cases, ["c2"]);
	assert.equal(again.queue[1].goal, "two", "the rest of the queue is untouched");
	assert.equal(queueIndexOf(again.queue, "o n e"), -1, "matching is on the normalised key, not character overlap");
});

test("the queue has a hard bound: entry GOAL_QUEUE_MAX fits, the next new goal is refused, an existing one still updates", () => {
	let queue = [];
	for (let i = 0; i < GOAL_QUEUE_MAX; i++) queue = enqueueGoal(queue, entry(`g${i}`)).queue;
	assert.equal(queue.length, GOAL_QUEUE_MAX);
	const refused = enqueueGoal(queue, entry("overflow"));
	assert.equal(refused.ok, false);
	assert.equal(refused.queue, queue, "a full queue is returned untouched");
	const refresh = enqueueGoal(queue, entry(" G0 ", ["fresh"]));
	assert.equal(refresh.ok, true, "updating an already-queued goal is not subject to the bound");
	assert.equal(refresh.queue.length, GOAL_QUEUE_MAX);
	assert.deepEqual(refresh.queue[0].cases, ["fresh"]);
});

test("advancing an empty queue changes nothing: the current goal survives and no queue appears", () => {
	const driver = { goal: "still running", confirmedAt: 0, attempts: { rounds: 2, fingerprints: [], caseRounds: {} } };
	const state = { goalDriver: driver };
	assert.equal(advanceGoalQueue(state), undefined);
	assert.equal(state.goalDriver, driver, "the open goal is never swapped for nothing");
	assert.equal(state.goalQueue, undefined);
});

test("a promoted goal brings its confirmation context with it: lang, chrome and the human's clarify notes", () => {
	const state = {
		goalQueue: [{ goal: "next", cases: ["c1"], queuedAt: 5, lang: "th", chrome: { title: "ยืนยัน" }, notes: ["note one"] }],
		decisions: [{ at: 1, from: "old", question: "q", assumption: "stale" }],
	};
	const next = advanceGoalQueue(state, 100);
	assert.equal(next.goal, "next");
	assert.equal(state.goalLang, "th");
	assert.deepEqual(state.goalChrome, { title: "ยืนยัน" });
	assert.deepEqual(state.goalDriver.cases, ["c1"]);
	assert.equal(state.decisions.length, 1, "the closed goal's decisions leave with it");
	assert.equal(state.decisions[0].assumption, "note one");
	assert.equal(state.decisions[0].at, 100);
});

test("the notes speak the human's language and always name the goal and the queue position", () => {
	const th = goalQueuedNote("งานใหม่", 2, 3, "งานเดิม", "th");
	assert.match(th, /2\/3/);
	assert.match(th, /งานใหม่/);
	assert.match(th, /งานเดิม/);
	const en = goalQueuedNote("new work", 2, 3, "old work", "en");
	assert.match(en, /2\/3/);
	assert.match(en, /new work/);
	assert.notEqual(goalPromotedNote("g", "th"), goalPromotedNote("g", "en"), "the promotion note is translated, never one language for all");
	assert.match(goalQueueFullNote(GOAL_QUEUE_MAX, "th"), new RegExp(`${GOAL_QUEUE_MAX}`));
});

test("a declined or timed-out queue dialog is a soft refusal: both goals are named and the run is never announced as stopped", () => {
	for (const lang of ["th", "en"]) {
		for (const outcome of ["declined", "timeout"]) {
			const note = goalQueueRefusedNote("งานใหม่", "งานเดิม", outcome, 120, lang);
			assert.match(note, /งานใหม่/);
			assert.match(note, /งานเดิม/);
			if (outcome === "timeout") assert.match(note, /120/);
			assert.match(note, lang === "th" ? /ไม่มีการหยุดงาน/ : /nothing was stopped/, "the note says the run keeps going, never that it halted");
			assert.doesNotMatch(note, /⛔|halted/i);
		}
	}
});

test("tools.ts wires the queue refusal soft: the queue-candidate branch never arms the goal stop and never terminates", () => {
	const src = readFileSync(join(new URL("..", import.meta.url).pathname, "extensions/finisher/src/tools.ts"), "utf8");
	const start = src.indexOf('if (outcome !== "confirmed")');
	const end = src.indexOf("return refusal(outcome);", start);
	assert.ok(start >= 0 && end > start, "the queue branch must sit between the dialog outcome and the hard refusal");
	const soft = src.slice(start, end);
	assert.match(soft, /goalQueueRefusedNote/);
	assert.doesNotMatch(soft, /armGoalStop/, "a queue decline must not arm the goal stop that aborts the running goal");
	assert.doesNotMatch(soft, /terminate/, "a queue decline must not terminate the session");
	assert.match(soft, /goalConsent/, "the same human turn never re-opens a dialog the human just dismissed");
});

const verifySession = () => {
	const defs = [];
	const asked = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return box.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal) => (asked.push(goal), "confirmed"),
		launchSubagent: async (_ctx, role) => {
			box.get().subagentRuns.push({ role, ok: true, summary: "", at: Date.now(), status: "done", logPath: "/tmp/x.log" });
			return { ok: true, output: "done", logPath: "/tmp/x.log", calls: [] };
		},
	});
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "finisher-queue-")), model: { provider: "p", id: "m" }, hasUI: true, mode: "tui", ui: { notify: () => {} } };
	return { asked, box, run: (name, params) => defs.find((d) => d.name === name).execute("c1", params, undefined, undefined, ctx) };
};

test("closing a goal through verify promotes the queue head in the same call: open, fresh, and never re-confirmed", async () => {
	const s = verifySession();
	await s.run("goal", { goal: "the running goal", cases: ["v1 holds"] });
	await s.run("goal", { goal: "the queued goal", cases: ["n1 holds"] });
	s.box.get().verifyCalls = [{ command: "npm test", ok: true }];
	const done = await s.run("verify", { skipDeterministic: true, cases: [{ id: "v1 holds", command: "npm test" }] });
	assert.equal(done.details.promoted, "the queued goal");
	const driver = s.box.get().goalDriver;
	assert.equal(driver.goal, "the queued goal");
	assert.equal(driver.doneAt, undefined, "the promoted goal is open, never born closed");
	assert.equal(driver.attempts.rounds, 0, "it starts with fresh attempts, not the closed run's budget");
	assert.deepEqual(driver.cases, ["n1 holds"], "with exactly the cases the human confirmed at enqueue");
	assert.equal(s.box.get().goalQueue, undefined, "a drained queue clears its field");
	assert.deepEqual(s.asked, ["the running goal", "the queued goal"], "promotion opens no dialog — the confirmation happened at enqueue, once per goal");
});

test("a failed verify round never promotes: the queue waits for the goal to actually close", async () => {
	const s = verifySession();
	await s.run("goal", { goal: "open goal", cases: ["x"] });
	await s.run("goal", { goal: "queued goal", cases: ["y"] });
	await s.run("verify", { skipDeterministic: true, cases: [] });
	assert.equal(s.box.get().goalDriver.goal, "open goal", "a replan round keeps the running goal");
	assert.equal(s.box.get().goalDriver.doneAt, undefined, "and it is not closed either");
	assert.deepEqual(s.box.get().goalQueue.map((q) => q.goal), ["queued goal"], "the head keeps waiting for a real close");
});
