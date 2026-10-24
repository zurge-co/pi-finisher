import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_HIT, REPORT_HIT, REPORT_MARK, createPanelWidget, createStateBox, createViewers, hudHitMap, liveReport, writeReportFile } from "../extensions/finisher/index.ts";

const closedGoal = () => ({
	goal: "ship the race HUD",
	confirmedAt: 1_000,
	attempts: { rounds: 1 },
	phases: [{ id: "p-one", text: "write the report", round: 0, addedAt: 1_000 }],
	lap: 1,
	lapAt: 2_000,
	lapMs: [1_000],
	doneAt: 62_000,
	outcome: "verified",
});

const harness = (box, opened, cwd) => {
	const sent = [];
	const widget = createPanelWidget({
		pi: {},
		get state() {
			return box.get();
		},
		openAgentSession: async () => {
			opened.push("agent");
			return null;
		},
		openGoalPage: async () => {
			opened.push("goal");
			return null;
		},
		openReportPage: async () => {
			opened.push("report");
			return null;
		},
	});
	const ctx = { hasUI: true, cwd, ui: { setWidget: (key, factory, opts) => sent.push({ key, factory, opts }), setStatus: () => {} } };
	widget.updateWidget(ctx);
	const component = sent.at(-1).factory({}, { fg: (_token, text) => text });
	return { component, click: (y) => component.handleMouse({ type: "click", y, x: 0, screenX: 0, screenY: y, button: "left", shift: false, alt: false, ctrl: false, width: 120, height: 20 }) };
};

const stateWith = (meta) => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	box.get().goalDriver = closedGoal();
	box.get().subagentRuns.push({ role: "swarm", ok: false, summary: "", at: 11, startedAt: 1_000, status: "running", slotId: "s1" });
	box.get().lastReport = meta;
	return box;
};

test("the report row opens the report page, and the goal row still opens the goal page", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-click-"));
	const meta = writeReportFile(cwd, { goal: "ship the race HUD", outcome: "verified", at: 62_000, laps: 1, round: 1, body: "# verdict\n✓ every case" });
	const box = stateWith(meta);
	const opened = [];
	const { component, click } = harness(box, opened);
	const lines = component.render(120);
	const hits = hudHitMap({ runs: box.get().subagentRuns, goal: box.get().goalDriver, report: liveReport(meta), lanes: 5, width: 120, now: Date.now() });
	const reportRow = lines.findIndex((l) => l.includes(REPORT_MARK));
	assert.ok(reportRow >= 0, "the closed goal puts a report row on the HUD");
	assert.equal(hits[reportRow], REPORT_HIT, "that row carries the report hit");
	assert.equal(REPORT_HIT === GOAL_HIT, false, "the report hit is never the goal hit");
	click(reportRow);
	assert.deepEqual(opened, ["report"], "clicking the report row opens the report, not an agent");
	opened.length = 0;
	click(lines.findIndex((l) => l.includes("ship the race HUD")));
	assert.deepEqual(opened, ["goal"], "the goal row keeps its own page");
	opened.length = 0;
	click(lines.findIndex((l) => l.includes("s1")));
	assert.deepEqual(opened, ["agent"], "an agent row stays an agent row");
	rmSync(cwd, { recursive: true, force: true });
});

test("a report left on disk advertises itself with no meta in state, and the click still opens it", () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-nometa-"));
	writeReportFile(cwd, { goal: "ship the race HUD", outcome: "verified", at: 62_000, laps: 1, round: 1, body: "body" });
	const box = stateWith(undefined);
	const opened = [];
	const { component, click } = harness(box, opened, cwd);
	const lines = component.render(120);
	const reportRow = lines.findIndex((l) => l.includes(REPORT_MARK));
	assert.ok(reportRow >= 0, "the file on disk is the row, even with nothing in state");
	click(reportRow);
	assert.deepEqual(opened, ["report"], "and that row opens the report page");
	rmSync(cwd, { recursive: true, force: true });
});

test("a report that is gone advertises nothing and no row opens the report page", () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-gone-"));
	const meta = writeReportFile(cwd, { goal: "ship the race HUD", outcome: "verified", at: 62_000, laps: 1, round: 1, body: "body" });
	const box = stateWith(meta);
	const opened = [];
	const { component, click } = harness(box, opened);
	rmSync(meta.path);
	const lines = component.render(120);
	assert.deepEqual(lines.filter((l) => l.includes(REPORT_MARK)), [], "the dead report row is not painted");
	const hits = hudHitMap({ runs: box.get().subagentRuns, goal: box.get().goalDriver, report: liveReport(meta), lanes: 5, width: 120 });
	assert.equal(hits.includes(REPORT_HIT), false, "and nothing on screen carries its hit");
	for (let y = 0; y < lines.length; y++) click(y);
	assert.equal(opened.includes("report"), false, "no click on that screen opens a report");
	assert.deepEqual(opened, ["goal", "agent"], "the rows that remain keep their own pages");
	rmSync(cwd, { recursive: true, force: true });
});

test("opening a report with nothing written is a notice, never a crash", async () => {
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const viewers = createViewers({
		get state() {
			return box.get();
		},
		finisherCustom: undefined,
		OVERLAY_XL: {},
		scrollKeyAction: () => null,
		persist: () => {},
		pi: {},
	});
	const messages = [];
	const ctx = { cwd: tmpdir(), mode: "text", ui: { notify: (text) => messages.push(text) } };
	await viewers.openReportPage(ctx);
	assert.match(messages[0], /no report yet/, "with no goal closed yet the answer is a notice");
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-view-"));
	const meta = writeReportFile(cwd, { goal: "ship the race HUD", outcome: "needs-human", at: 62_000, laps: 2, round: 3, body: "a case only the human can check" });
	box.get().lastReport = meta;
	await viewers.openReportPage(ctx);
	assert.ok(messages[1].includes("a case only the human can check"), "a text session reads the report inline");
	rmSync(meta.path);
	await viewers.openReportPage(ctx);
	assert.match(messages[2], /report file is gone/, "a deleted file says so instead of pretending");
	const fresh = mkdtempSync(join(tmpdir(), "finisher-report-disk-"));
	writeReportFile(fresh, { goal: "ship the race HUD", outcome: "verified", at: 62_000, laps: 1, round: 1, body: "read straight from disk" });
	box.get().lastReport = undefined;
	await viewers.openReportPage({ ...ctx, cwd: fresh });
	assert.match(messages[3], /read straight from disk/, "the report on disk opens without a meta in state");
	rmSync(fresh, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
