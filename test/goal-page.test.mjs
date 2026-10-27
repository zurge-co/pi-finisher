import { test } from "node:test";
import assert from "node:assert/strict";
import {
	GOAL_HIT,
	GOAL_PAGE_CHROME_ROWS,
	completeLap,
	createPanelWidget,
	createStateBox,
	createViewers,
	declarePlan,
	goalPageBody,
	goalPageCeiling,
	goalPageLines,
	goalPageLinesText,
	goalPageMaxOffset,
	goalPageStep,
	goalPageTitle,
	goalPageViewport,
	goalPageWindow,
	hudFrames,
	hudHitMap,
} from "../extensions/finisher/index.ts";
import { createGui } from "../extensions/finisher/src/gui.ts";

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

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };

const openPlanPage = (lapCount, columns, rows) => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const plan = declarePlan(Array.from({ length: lapCount }, (_, i) => `lap ${i + 1} of ${lapCount} proves something with a tail long enough to wrap`), 1_000);
	box.get().goalDriver = { goal: "scroll the plan", confirmedAt: 1_000, attempts: { rounds: 0, verifies: 0 }, phases: plan.phases, lap: 1, lapAt: 1_000, lapMs: plan.lapMs };
	const gui = createGui({ pi: {} });
	const viewers = createViewers({ get state() { return box.get(); }, finisherCustom: gui.finisherCustom, OVERLAY_XL: gui.OVERLAY_XL, scrollKeyAction: gui.scrollKeyAction, persist: () => {}, pi: {} });
	let component;
	let result;
	const tui = { terminal: { columns, rows }, requestRender: () => {} };
	viewers.openGoalPage({ cwd: "/tmp", mode: "tui", hasUI: true, ui: { notify: () => {}, custom: (factory) => { component = factory(tui, theme, {}, (value) => { result = value; }); return new Promise(() => {}); } } });
	const render = () => component.render(columns).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	return { rows, render, key: (data) => component.handleInput(data), closed: () => result === null, dispose: () => component.dispose() };
};

test("the plan page reaches every lap of a long plan by scrolling, at every terminal size, and never draws taller than its ceiling", async () => {
	for (const [rows, columns] of [[10, 40], [12, 60], [24, 100], [40, 160]]) {
		const page = openPlanPage(24, columns, rows);
		const drawn = new Set();
		const sweep = (out) => {
			assert.ok(out.length <= goalPageCeiling(rows), `${rows}x${columns}: the page draws ${out.length} rows in a ${goalPageCeiling(rows)}-row ceiling`);
			for (const hit of out.join("\n").matchAll(/lap (\d+) of \d+/g)) drawn.add(Number(hit[1]));
		};
		sweep(page.render());
		for (let i = 0; i < 80; i++) {
			page.key("\x1b[6~");
			sweep(page.render());
		}
		assert.equal(drawn.size, 24, `${rows}x${columns}: paging down puts all 24 laps on the page, only ${drawn.size} were drawn`);
		assert.ok(page.render().some((l) => l.includes("lap 24 of 24")), `${rows}x${columns}: the last lap is reachable at the bottom`);
		page.key("\x1b[H");
		assert.ok(page.render().some((l) => l.includes("lap 1 of 24")), `${rows}x${columns}: Home returns to the first lap`);
		page.dispose();
	}
});

test("every scroll key moves the plan page by its own step and stops exactly at the bottom row", () => {
	for (const total of [1, 4, 5, 40, 400]) {
		for (const rows of [1, 3, 9, 21]) {
			const max = Math.max(0, total - Math.max(1, rows));
			assert.equal(goalPageStep(total, rows, 0, "bottom"), max, `total ${total} rows ${rows}: End lands on the last row, not past it`);
			assert.equal(goalPageStep(total, rows, max, "top"), 0, `total ${total} rows ${rows}: Home lands on the first row`);
			assert.equal(goalPageStep(total, rows, 0, "up"), 0, `total ${total} rows ${rows}: scrolling up from the top stays at the top`);
			assert.equal(goalPageStep(total, rows, max, "down"), max, `total ${total} rows ${rows}: scrolling down from the bottom stays at the bottom`);
			assert.equal(goalPageStep(total, rows, max, "pageDown"), max, `total ${total} rows ${rows}: a page down at the bottom changes nothing`);
			let down = 0;
			for (let i = 0; i < total + 2; i++) down = goalPageStep(total, rows, down, "down");
			assert.equal(down, max, `total ${total} rows ${rows}: stepping down enough times reaches the bottom and never leaves it`);
			let up = max;
			for (let i = 0; i < total + 2; i++) up = goalPageStep(total, rows, up, "up");
			assert.equal(up, 0, `total ${total} rows ${rows}: stepping up enough times returns to the top`);
			assert.equal(goalPageStep(total, rows, 0, "pageDown"), Math.min(max, rows), `total ${total} rows ${rows}: one page down is one viewport`);
		}
	}
});

test("the plan page's viewport leaves room for its own chrome: rows never overlap the header or the key line", () => {
	for (const termRows of [1, 6, 10, 24, 60, 120]) {
		const ceiling = goalPageCeiling(termRows);
		assert.ok(ceiling <= Math.max(4, Math.floor((termRows || 24) * 0.9)), `term ${termRows}: the overlay stays inside its share of the screen`);
		for (const header of [1, 2, 5, 20]) {
			const viewport = goalPageViewport(termRows, header);
			assert.equal(viewport, Math.max(1, ceiling - header - GOAL_PAGE_CHROME_ROWS), `term ${termRows} header ${header}: the body is exactly what the chrome leaves`);
			if (ceiling - header - GOAL_PAGE_CHROME_ROWS >= 1) assert.equal(header + viewport + GOAL_PAGE_CHROME_ROWS, ceiling, `term ${termRows} header ${header}: header, body and key line fill the ${ceiling}-row page exactly, never past it`);
		}
	}
	const lines = goalPageLines(goalAt(2));
	const wide = goalPageBody(lines, 200, 0, 3);
	const narrow = goalPageBody(lines, 24, 0, 3);
	assert.ok(narrow.from === wide.from && narrow.to <= wide.to, "a narrower page never shows more rows than a wider one: wrapping only adds rows");
});

test("q closes the plan page exactly like Esc, and no scroll key closes it", () => {
	const closedBy = (key) => {
		const page = openPlanPage(40, 80, 14);
		page.render();
		page.key(key);
		const closed = page.closed();
		page.dispose();
		return closed;
	};
	for (const key of ["q", "\x1b", "\x1b[27u", "\r"]) assert.equal(closedBy(key), true, `${JSON.stringify(key)} closes the page`);
	for (const key of ["\x1b[6~", "\x1b[5~", "\x1b[B", "\x1b[A", "\x1b[H", "\x1b[F"]) assert.equal(closedBy(key), false, `${JSON.stringify(key)} scrolls instead of closing`);
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
