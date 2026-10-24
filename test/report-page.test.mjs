import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REPORT_HIT,
	hudFrames,
	hudHitMap,
	hudLines,
	reportIdleTail,
	reportPageLines,
	reportPageMaxOffset,
	reportPageWindow,
	reportRowText,
	readReportFile,
	withReportTail,
	writeReportFile,
} from "../extensions/finisher/index.ts";

const run = (role, extra = {}) => ({ role, status: "running", startedAt: 1_000, at: 1_000, ...extra });
const phases = [
	{ id: "p-one", text: "write the report file", round: 0, addedAt: 1_000 },
	{ id: "p-two", text: "prove it with a command", round: 0, addedAt: 1_000 },
];
const open = { goal: "ship the report row", confirmedAt: 1_000, phases, lap: 1, lapAt: 2_000, lapMs: [] };
const closed = { ...open, doneAt: 62_000, outcome: "verified" };
const report = { outcome: "verified", laps: 2, at: 62_000, goal: "ship the report row" };

test("no HUD line ever exceeds the terminal width once a report is on screen", () => {
	for (let width = 8; width <= 200; width++) {
		for (const input of [
			{ runs: [], width, report },
			{ runs: [], width, goal: closed, report },
			{ runs: [], width, goal: open, report },
			{ runs: [run("swarm", { slotId: "s1", model: "provider/long-model-name" })], width, goal: closed, report },
			{ runs: [run("swarm", { slotId: "s1" })], width, goal: open, report },
		]) {
			const lines = hudLines({ now: 90_000, ...input });
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}" is ${visibleWidth(line)} wide`);
			assert.equal(hudHitMap({ now: 90_000, ...input }).length, lines.length, `width ${width}: one hit slot per painted line`);
		}
	}
});

test("a finished goal is one line, and that line is the report's click target", () => {
	const lines = hudLines({ runs: [], width: 100, goal: closed, report });
	assert.equal(lines.length, 1, "a closed goal still costs one line, not a panel");
	assert.ok(lines[0].endsWith("report"), `the idle line ends with the report: "${lines[0]}"`);
	assert.deepEqual(hudHitMap({ runs: [], width: 100, goal: closed, report }), [REPORT_HIT]);
	assert.deepEqual(hudHitMap({ runs: [], width: 100, report }), [REPORT_HIT], "with no goal at all the idle line still offers the report");
	assert.deepEqual(hudHitMap({ runs: [], width: 100 }), [undefined], "and without a report the idle line is nobody's target");
	assert.equal(REPORT_HIT < 0 && REPORT_HIT !== -1, true, "the report hit is its own negative slot");
});

test("a report on disk is clickable whether the goal is open, closed, or gone", () => {
	for (const runs of [[], [run("swarm", { slotId: "s1" })]]) {
		for (const goal of [undefined, open, closed]) {
			const label = goal ? (goal.doneAt ? "closed" : "open") : "absent";
			const rows = hudFrames({ runs, width: 100, goal, report }).filter((f) => f.hit === REPORT_HIT);
			assert.equal(rows.length, 1, `${label}: exactly one clickable report line`);
			const carries = rows[0].text.includes(reportRowText(report)) || rows[0].text.includes(reportIdleTail(report));
			assert.ok(carries, `${label}: the clickable line is the report, not a run row`);
			assert.deepEqual(hudFrames({ runs, width: 100, goal }).filter((f) => f.hit === REPORT_HIT), [], `${label}: without a report nothing claims the report slot`);
		}
	}
});

test("the report tail survives every width it can survive, and the line never overflows", () => {
	const tail = reportIdleTail(report);
	const tailWidth = visibleWidth(tail);
	for (let width = 0; width <= 80; width++) {
		const out = withReportTail("▚ ".concat("x".repeat(200)), tail, width);
		assert.ok(visibleWidth(out) <= width, `width ${width}: "${out}" is ${visibleWidth(out)} wide`);
		if (width >= tailWidth + 4) assert.ok(out.endsWith(tail), `width ${width}: the report stays clickable`);
	}
});

test("the report page keeps every line of the file, including the empty and the Thai ones", () => {
	const text = ["# finisher report — verified", "", "goal: ship the report row", "  ✓ a case  (1:02)", "บรรทัดภาษาไทยที่ยาว ".repeat(20), ""].join("\n");
	assert.deepEqual(reportPageLines(text), ["# finisher report — verified", "", "goal: ship the report row", "  ✓ a case  (1:02)", "บรรทัดภาษาไทยที่ยาว ".repeat(20)]);
});

test("the page wraps a long line instead of cutting it, at every width", () => {
	const long = "case one proved by npm test -- report-page with a very long tail ".repeat(3);
	const thai = "บรรทัดภาษาไทยที่ยาวมากและต้องไม่ถูกตัดกลางคำ ".repeat(3);
	const text = ["# finisher report — verified", long, "", thai, "  ✓ a case  (1:02)"].join("\n");
	const strip = (s) => s.replace(/\s+/g, "");
	for (let width = 4; width <= 60; width++) {
		const body = reportPageLines(text).flatMap((ln) => wrapTextWithAnsi(ln, width));
		for (const ln of body) assert.ok(visibleWidth(ln) <= width, `width ${width}: "${ln}" is ${visibleWidth(ln)} wide`);
		assert.equal(strip(body.join("")), strip(text), `width ${width}: the page shows every character of the report`);
	}
});

test("the last line of a real report on disk is reachable by scrolling to the bottom", () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-page-"));
	const body = Array.from({ length: 200 }, (_, i) => `case line ${i}`).join("\n");
	const meta = writeReportFile(cwd, { goal: "ship the report page", outcome: "verified", at: 62_000, laps: 4, round: 2, body });
	const lines = reportPageLines(readReportFile(meta.path));
	assert.ok(lines.length > 200, "the page holds the whole document, heading lines included");
	const { from, to } = reportPageWindow(lines.length, 10, reportPageMaxOffset(lines.length, 10));
	assert.equal(to, lines.length, "the bottom of the real report is the bottom of the page");
	assert.equal(lines[to - 1], "case line 199", "and the last line shown is the last line written");
	assert.equal(from, lines.length - 10);
	rmSync(cwd, { recursive: true, force: true });
});

test("every offset of the report page lands inside the file and the last page reaches the last line", () => {
	for (const total of [0, 1, 5, 40]) {
		for (const rows of [1, 4, 9]) {
			const height = Math.max(4, rows);
			for (let offset = -3; offset <= total + 3; offset++) {
				const { from, to } = reportPageWindow(total, rows, offset);
				assert.ok(from >= 0 && to <= total && from <= to, `total ${total} rows ${rows} offset ${offset}: the window stays inside`);
				if (total > height) assert.equal(to - from, height, `total ${total} rows ${rows} offset ${offset}: one full page`);
			}
			const last = reportPageWindow(total, rows, reportPageMaxOffset(total, rows));
			if (total > 0) assert.equal(last.to, total, `total ${total} rows ${rows}: the bottom of the report is reachable`);
		}
	}
});
