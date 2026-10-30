import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compactionHold, heldGoalFor, HELD_OUTCOMES, outcomeNeedsHuman } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const reasons = ["manual", "threshold", "overflow"];
const outcomes = [undefined, "verified", "needs-human", "halted"];
const DONE = 5_000;

test("the report survives exactly while a human still has to act on it — total law over outcome × reason × reply", () => {
	for (const reason of reasons) {
		for (const outcome of outcomes) {
			for (const humanAt of [undefined, DONE - 1, DONE, DONE + 1]) {
				const goal = { doneAt: DONE, ...(outcome ? { outcome } : {}) };
				const { hold } = compactionHold({ reason, goal, humanAt });
				const unread = outcomeNeedsHuman(outcome) && DONE > (humanAt ?? 0);
				const expected = reason !== "manual" && unread;
				assert.equal(hold, expected, `reason=${reason} outcome=${outcome} humanAt=${humanAt}`);
			}
		}
	}
});

test("an open goal and a verified goal never hold, whatever the reason", () => {
	for (const reason of reasons) {
		assert.equal(compactionHold({ reason, goal: undefined }).hold, false);
		assert.equal(compactionHold({ reason, goal: { outcome: "halted" } }).hold, false, "no doneAt means the run is still open");
		assert.equal(compactionHold({ reason, goal: { doneAt: DONE, outcome: "verified" } }).hold, false, "a verified run has nothing left to read");
	}
});

test("a promotion never drops the hold: the closed run's report still blocks compaction until the human reads it", () => {
	const state = { goalDriver: { goal: "queued next", confirmedAt: DONE + 10 }, lastReport: { at: DONE, outcome: "halted" } };
	assert.equal(compactionHold({ reason: "threshold", goal: heldGoalFor(state), humanAt: DONE - 1 }).hold, true);
	assert.equal(compactionHold({ reason: "threshold", goal: heldGoalFor(state), humanAt: DONE + 20 }).hold, false, "a reply after the close lifts the hold even with a queued goal promoted");
	assert.equal(compactionHold({ reason: "threshold", goal: heldGoalFor({ lastReport: { at: DONE, outcome: "verified" } }) }).hold, false, "a verified report never holds");
	assert.equal(compactionHold({ reason: "threshold", goal: heldGoalFor({ goalDriver: { goal: "open" } }) }).hold, false, "an open run with no report never holds");
});

test("the hold names its reason so the human is told why compaction was skipped", () => {
	for (const outcome of HELD_OUTCOMES) {
		const held = compactionHold({ reason: "threshold", goal: { doneAt: DONE, outcome } });
		assert.equal(held.hold, true);
		assert.match(held.note, /compaction held/);
		assert.match(held.note, /human/);
	}
});

test("the registered hook really cancels: it holds an unread failed report, and releases once the human has spoken", async () => {
	const { mkdtempSync, mkdirSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const hooks = new Map();
	const ext = (await import("../extensions/finisher/index.ts")).default;
	const saved = process.env.PI_FINISHER_SUBAGENT;
	process.env.PI_FINISHER_SUBAGENT = "0";
	try {
		ext({ on: (n, fn) => (hooks.set(n, [...(hooks.get(n) ?? []), fn]), () => {}), registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {}, registerVirtualModel: () => {}, appendEntry: () => {} });
	} finally {
		if (saved === undefined) delete process.env.PI_FINISHER_SUBAGENT;
		else process.env.PI_FINISHER_SUBAGENT = saved;
	}
	assert.ok(hooks.has("session_before_compact"), "the hook must be registered or nothing is held");
	const cwd = mkdtempSync(join(tmpdir(), "finisher-hold-"));
	const ctxFor = (data) => ({ cwd, mode: "rpc", hasUI: false, ui: { notify: () => {}, setWidget: () => {} }, sessionManager: { getEntries: () => [{ type: "custom", customType: "finisher-state", data }] } });
	const fire = async (ctx, reason) => {
		let out;
		for (const h of hooks.get("session_before_compact")) {
			const r = await h({ type: "session_before_compact", reason, preparation: {}, branchEntries: [], willRetry: false, signal: new AbortController().signal }, ctx);
			if (r) out = r;
		}
		return out;
	};
	const state = (extra) => ({ phase: "requirements", turnsUsed: 1, tokensUsed: 1, escalations: [], trajectoryFlags: [], subagentRuns: [], goalDriver: { goal: "g", confirmedAt: 1, attempts: { rounds: 1 }, doneAt: 5_000, outcome: "halted" }, ...extra });
	for (const [label, data, reason, expected] of [
		["unread halted", state({}), "threshold", true],
		["unread halted (overflow)", state({}), "overflow", true],
		["manual", state({}), "manual", false],
		["verified", state({ goalDriver: { goal: "g", confirmedAt: 1, attempts: { rounds: 1 }, doneAt: 5_000, outcome: "verified" } }), "threshold", false],
		["human replied", state({ humanAt: 5_001 }), "threshold", false],
		["open goal", state({ goalDriver: { goal: "g", confirmedAt: 1, attempts: { rounds: 1 } } }), "threshold", false],
	]) {
		const ctx = ctxFor(data);
		for (const h of hooks.get("session_start")) await h({ type: "session_start" }, ctx);
		const out = await fire(ctx, reason);
		assert.equal(out?.cancel === true, expected, label);
	}
});

test("the guard is wired into pi, not merely exported", () => {
	const index = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	assert.match(index, /pi\.on\("session_before_compact"/);
	assert.match(index, /cancel: true/);
	assert.match(index, /reportUnread\(/);
});
