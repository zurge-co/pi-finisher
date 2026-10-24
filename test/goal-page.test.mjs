import { test } from "node:test";
import assert from "node:assert/strict";
import {
	GOAL_HIT,
	completeLap,
	createPanelWidget,
	createStateBox,
	declarePlan,
	goalPageLines,
	goalPageLinesText,
	goalPageMaxOffset,
	goalPageTitle,
	goalPageWindow,
	hudFrames,
	hudHitMap,
} from "../extensions/finisher/index.ts";

const plan3 = () => {
	let p = declarePlan(["survey the parser", "rewrite the retry policy", "prove it with a command"], 1_000);
	p = completeLap(p, undefined, 11_000);
	p = completeLap(p, undefined, 26_000);
	return p;
};

const goalAt = (lap = 3, extra = {}) => {
	const plan = plan3();
	return { goal: "ship the new HUD", confirmedAt: 1_000, phases: plan.phases, lap, lapAt: 26_000, lapMs: plan.lapMs, ...extra };
};

test("the goal page shows every lap in full: no lap text is ever truncated, however long it is", () => {
	const long = "x".repeat(300);
	const texts = [`short one`, long, `a lap with "quotes" and  double  spaces`];
	const goal = { goal: "g", confirmedAt: 1_000, phases: texts.map((text, i) => ({ id: `p-${i}`, text, round: 0, addedAt: 1_000 })), lap: 2, lapAt: 2_000 };
	const lines = goalPageLines(goal);
	assert.equal(lines.length, texts.length, "one page line per declared lap");
	assert.deepEqual(lines.map((l) => l.text), texts, "the page carries the lap text verbatim, never a clipped copy");
	for (const [i, rendered] of goalPageLinesText(goal).entries()) assert.ok(rendered.includes(texts[i]), `lap ${i + 1} must appear whole on the page: ${rendered}`);
});

test("the page marks exactly the closed laps as done and exactly one lap as current, in order", () => {
	for (let lap = 1; lap <= 4; lap++) {
		const lines = goalPageLines(goalAt(lap));
		const marks = lines.map((l) => l.mark).join("");
		const closed = Math.min(3, lap - 1);
		assert.equal(marks, `${"✓".repeat(closed)}${lap > 3 ? "" : "▶"}${"·".repeat(Math.max(0, 3 - closed - (lap > 3 ? 0 : 1)))}`, `lap ${lap}: ${marks}`);
		assert.equal([...marks].filter((m) => m === "▶").length, lap > 3 ? 0 : 1, `lap ${lap}: at most one current lap`);
	}
});

test("the page title states the lap position and the total goal clock, and names neither finisher nor a total-time label", () => {
	const title = goalPageTitle(goalAt(2), 41_000);
	assert.match(title, /LAP 2\/3/, `the page says where the goal is: ${title}`);
	assert.match(title, /0:40/, `the page carries the clock of the whole goal: ${title}`);
	assert.ok(!/finisher|total time/i.test(title), `no brand and no "total time" wording: ${title}`);
	assert.match(goalPageTitle({ goal: "empty" }), /no lap declared yet/);
});

test("the goal page window is a bounded, total view of the laps: every offset shows a full window that never leaves the plan", () => {
	for (const total of [0, 1, 4, 7, 30]) {
		for (const rows of [1, 4, 9]) {
			const height = Math.max(4, rows);
			for (let offset = -3; offset <= total + 3; offset++) {
				const { from, to } = goalPageWindow(total, rows, offset);
				const max = goalPageMaxOffset(total, rows);
				assert.ok(from >= 0, `total ${total} rows ${rows} offset ${offset}: the window starts inside the plan`);
				assert.ok(to <= total, `total ${total} rows ${rows} offset ${offset}: the window ends inside the plan`);
				assert.ok(to - from <= Math.max(height, total), `total ${total} rows ${rows} offset ${offset}: the window is bounded`);
				if (total > height) assert.equal(to - from, height, `total ${total} rows ${rows} offset ${offset}: a scrolling plan shows exactly one page`);
				assert.ok(from <= max, `total ${total} rows ${rows} offset ${offset}: never past the last page`);
			}
		}
	}
	assert.equal(goalPageMaxOffset(3, 9), 0, "a plan that fits needs no scrolling at all");
});

test("the goal row of the HUD is a click target of its own, and the goal page opens instead of an agent page", async () => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	box.get().goalDriver = { goal: "ship the new HUD", confirmedAt: 1_000, attempts: { rounds: 0, verifies: 0 }, phases: goalAt(2).phases, lap: 2, lapAt: 26_000, lapMs: [] };
	const sent = [];
	const opened = [];
	const widget = createPanelWidget({
		pi: {},
		get state() {
			return box.get();
		},
		openAgentSession: async () => opened.push("agent"),
		openGoalPage: async () => {
			opened.push("goal");
			return null;
		},
	});
	const ctx = { hasUI: true, ui: { setWidget: (key, factory, opts) => sent.push({ key, factory, opts }), setStatus: () => {} } };
	box.get().subagentRuns.push({ role: "swarm", ok: false, summary: "", at: 11, startedAt: 1_000, status: "running", slotId: "s1" });
	widget.updateWidget(ctx);
	const component = sent.at(-1).factory({}, { fg: (_token, text) => text });
	component.render(120);
	const input = { runs: box.get().subagentRuns, goal: box.get().goalDriver, lanes: 5, width: 120, now: Date.now() };
	const hits = hudHitMap(input);
	const lines = hudFrames(input).map((f) => f.text);
	const goalRow = lines.findIndex((l) => l.includes("ship the new HUD"));
	assert.equal(hits[goalRow], GOAL_HIT, "the goal line carries its own hit, not an agent index");
	assert.equal(GOAL_HIT >= 0, false, "the goal hit can never be mistaken for a run index");
	const click = (y) => component.handleMouse({ type: "click", y, x: 0, screenX: 0, screenY: y, button: "left", shift: false, alt: false, ctrl: false, width: 120, height: lines.length });
	click(goalRow);
	assert.deepEqual(opened, ["goal"], "clicking the goal row opens the goal page");
	opened.length = 0;
	click(lines.findIndex((l) => l.includes("s1")));
	assert.deepEqual(opened, ["agent"], "clicking an agent row still opens that agent");
});
