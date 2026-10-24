import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createStateBox, createViewers, readReportFile, writeReportFile } from "../extensions/finisher/index.ts";
import { createGui } from "../extensions/finisher/src/gui.ts";

const strip = (s) => s.replace(/\s+/g, "");

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };

const openReport = (cwd, meta, width, rows) => {
	const gui = createGui({ pi: {} });
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	box.get().lastReport = meta;
	const viewers = createViewers({
		get state() {
			return box.get();
		},
		finisherCustom: gui.finisherCustom,
		OVERLAY_XL: gui.OVERLAY_XL,
		scrollKeyAction: gui.scrollKeyAction,
		persist: () => {},
		pi: {},
	});
	let component;
	let settle;
	const closed = new Promise((resolve) => (settle = resolve));
	const notices = [];
	const tui = { terminal: { columns: width, rows }, requestRender: () => {} };
	const ui = {
		notify: (text) => notices.push(text),
		custom: (factory) => {
			component = factory(tui, theme, {}, settle);
			return closed;
		},
	};
	const pending = viewers.openReportPage({ cwd, mode: "tui", hasUI: true, ui });
	return {
		notices,
		render: () => component.render(width),
		key: (data) => component.handleInput(data),
		close: async () => {
			component.handleInput("\x1b");
			component.dispose();
			await pending;
		},
	};
};

const fresh = (body) => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-report-view-"));
	const meta = writeReportFile(cwd, { goal: "ship the report page", outcome: "verified", at: 62_000, laps: 3, round: 1, body });
	return { cwd, meta, done: () => rmSync(cwd, { recursive: true, force: true }) };
};

test("the real report page draws the whole file at every width: nothing is cut, only wrapped", async () => {
	const body = [
		"verdict: ทุกเคสมีคำสั่งที่พิสูจน์แล้ว",
		"",
		"case one  npm test -- report-view.test.mjs  (exit 0)",
		"บรรทัดภาษาไทยที่ยาวมากและต้องไม่ถูกตัดกลางคำ ".repeat(6),
		"a-single-line-that-is-three-hundred-characters-long ".repeat(6),
		...Array.from({ length: 40 }, (_, i) => `  ✓ case line ${i}  (1:02)`),
	].join("\n");
	const { cwd, meta, done } = fresh(body);
	const text = readReportFile(meta.path);
	for (const width of [40, 60, 100, 160]) {
		const page = openReport(cwd, meta, width, 60_000);
		const out = page.render();
		assert.deepEqual(page.notices, [], `width ${width}: a TUI session opens the page, never a text notice`);
		for (const line of out) assert.ok(visibleWidth(line) <= width, `width ${width}: a ${visibleWidth(line)}-wide line cannot be read in a ${width}-column page`);
		assert.ok(strip(out.join("")).includes(strip(text)), `width ${width}: every character of the file is on the page`);
		await page.close();
	}
	done();
});

test("the page follows the report to its last line, and g/G move between the top and that bottom", async () => {
	const body = Array.from({ length: 400 }, (_, i) => `case line ${i}`).join("\n");
	const { cwd, meta, done } = fresh(body);
	const page = openReport(cwd, meta, 100, 24);
	const opened = page.render();
	assert.ok(opened.some((l) => l.includes("case line 399")), "the page opens on the newest end of the report");
	const height = opened.length;
	page.key("g");
	const top = page.render();
	assert.ok(top.some((l) => l.includes("# finisher report — verified")), "g goes to the head of the report");
	assert.ok(top.some((l) => l.includes("case line 0")), "and the first body line is drawn");
	assert.equal(top.some((l) => l.includes("case line 399")), false, "the last line is off the top page");
	for (let i = 0; i < 400; i++) page.key("\x1b[6~");
	const bottom = page.render();
	assert.ok(bottom.some((l) => l.includes("case line 399")), "paging down reaches the last line");
	assert.equal(bottom.length, height, "scrolling never changes the height of the page");
	assert.equal(top.length, height);
	page.key("G");
	assert.ok(page.render().some((l) => l.includes("case line 399")), "G lands on the last line directly");
	await page.close();
	done();
});

test("one long report line is wrapped across several real rows instead of being clipped at the right edge", async () => {
	const long = "proof ".repeat(200).trim();
	const { cwd, meta, done } = fresh(`${long}\nlast line`);
	const page = openReport(cwd, meta, 50, 60_000);
	const out = page.render();
	for (const line of out) assert.ok(visibleWidth(line) <= 50, `a ${visibleWidth(line)}-wide line in a 50-column page`);
	assert.equal(strip(out.join("")).includes(strip(long)), true, "the whole long line is on the page, character for character");
	assert.ok(out.some((l) => l.includes("last line")), "and the line after it still follows");
	await page.close();
	done();
});
