import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FRESH_SUMMARY_MAX,
	LAP_DIRECTIVE,
	freshLapDecision,
	isTrackerEntry,
	lapCompactionSummary,
	trackerEntryDraft,
} from "../extensions/finisher/index.ts";
import { buildLapTracker, renderLapTracker } from "../extensions/finisher/index.ts";
import { declarePlan, completeLap } from "../extensions/finisher/index.ts";
import { freshGoalRun } from "../extensions/finisher/index.ts";

const openGoal = (texts = ["a", "b", "c"]) => {
	const plan = declarePlan(texts, 0);
	return { ...freshGoalRun("ship it", 1_000), phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs };
};

test("one reset per lap boundary: the lap that closed is summarized once, and the lap before it is never a boundary of its own", () => {
	const first = openGoal();
	assert.equal(freshLapDecision({ enabled: true, hasWork: true, goal: first, now: first.lapAt + 5_000 }).reset, false, "nothing has closed yet, so there is nothing to clear");

	const second = { ...first, ...completeLap(first, undefined, first.lapAt + 9_000) };
	const decided = freshLapDecision({ enabled: true, hasWork: true, goal: second, now: second.lapAt + 1_000 });
	assert.deepEqual(decided, { reset: true, lapAt: second.lapAt, lap: 2 }, "closing a lap is the boundary that opens the next one");

	assert.equal(freshLapDecision({ enabled: true, hasWork: true, goal: second, consumedLapAt: second.lapAt, now: second.lapAt + 60_000 }).reset, false, "the same boundary can never fire twice, however long the run continues");

	const third = { ...second, ...completeLap(second, undefined, second.lapAt + 9_000) };
	const next = freshLapDecision({ enabled: true, hasWork: true, goal: third, consumedLapAt: second.lapAt, now: third.lapAt + 1_000 });
	assert.equal(next.reset, true, "closing the next lap is a new boundary");
	assert.equal(next.lap, 3);
	assert.equal(next.lapAt, third.lapAt);
});

test("every reason not to reset wins over the boundary, and none of them depends on the plan", () => {
	const base0 = openGoal();
	const goal = { ...base0, ...completeLap(base0, undefined, base0.lapAt + 1_000) };
	const base = { enabled: true, hasWork: true, goal, now: goal.lapAt + 10_000 };
	const off = [
		[{ enabled: false }, "the switch still wins"],
		[{ hasWork: false }, "nothing was said, so nothing is compacted"],
		[{ aborted: true }, "an aborted run keeps its context so the human can read it"],
		[{ reportUnread: true }, "an unread report must stay on screen"],
		[{ consumedLapAt: goal.lapAt }, "an already-paid boundary is not paid twice"],
		[{ lastResetAt: base.now - 500 }, "two settles of one boundary do not compact twice"],
		[{ goal: undefined }, "no goal means no lap boundary"],
		[{ goal: { ...goal, doneAt: 5_000 } }, "a closed goal is no boundary at all, so the transcript stays"],
		[{ goal: { ...goal, phases: [] } }, "a goal with no declared plan has no laps to cross"],
	];
	for (const [patch, why] of off) assert.equal(freshLapDecision({ ...base, ...patch }).reset, false, why);
});

test("a finished plan has no open lap, so closing the last lap hands over to verify instead of compacting", () => {
	let one = openGoal(["only"]);
	one = { ...one, ...completeLap(one, undefined, one.lapAt + 1_000) };
	assert.equal(freshLapDecision({ enabled: true, hasWork: true, goal: one, now: one.lapAt + 2_000 }).reset, false, "a one-lap plan closes straight into verify");
	let many = openGoal(["a", "b"]);
	many = { ...many, ...completeLap(many, undefined, many.lapAt + 1_000) };
	many = { ...many, ...completeLap(many, undefined, many.lapAt + 1_000) };
	assert.equal(freshLapDecision({ enabled: true, hasWork: true, goal: many, now: 1e9 }).reset, false, "every lap is closed, so the next boundary is the goal's own");
});

test("the compaction summary carries the lap tracker, so a cleared context still knows which lap it is on", () => {
	const declared = openGoal(["read the parser", "rewrite the retry policy", "prove it"]);
	const goal = { ...declared, ...completeLap(declared, undefined, declared.lapAt + 1_000), cases: ["typecheck passes"] };
	const tracker = buildLapTracker(goal, [{ command: "npm test", ok: true }], 4_000);
	const summary = lapCompactionSummary(tracker);
	assert.ok(summary.startsWith(LAP_DIRECTIVE), "the directive explains why the context is gone before anything else");
	assert.ok(summary.includes(renderLapTracker(tracker)), "the tracker text is what survives the reset, verbatim");
	assert.ok(summary.includes("where: lap 2/3"), "the lap position survives the compaction");
	assert.ok(summary.includes("now: rewrite the retry policy"), "the lap that is still ahead survives, not the one just finished");
	assert.ok(!summary.includes("now: read the parser"), "the cleared lap is not handed back as if it were still open");
	assert.ok(summary.includes("typecheck passes"), "the confirmed cases survive");
	assert.ok(summary.length <= FRESH_SUMMARY_MAX, "a summary that outgrows the cap would be silently clipped mid-tracker");
});

test("the tracker entry and the compaction entry are a pair: one hidden message to read now, one summary to read after the reset", () => {
	const goal = openGoal(["a", "b"]);
	const summary = lapCompactionSummary(buildLapTracker(goal, [], 1_000));
	const entry = trackerEntryDraft(summary);
	assert.equal(entry.type, "custom_message");
	assert.equal(entry.customType, "finisher-tracker");
	assert.equal(entry.display, false, "the tracker is state for the model, not a message the human has to scroll past");
	assert.equal(entry.content, summary);
	assert.equal(isTrackerEntry({ type: "custom_message", customType: "finisher-tracker" }), false, "a message entry is not a custom entry");
	assert.equal(isTrackerEntry({ type: "custom", customType: "finisher-tracker" }), true);
	assert.equal(isTrackerEntry({ type: "custom", customType: "finisher-state" }), false);
	assert.equal(isTrackerEntry(undefined), false);
});
