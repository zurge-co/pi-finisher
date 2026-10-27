import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createStateBox, createViewers, encodeToolEvent } from "../extensions/finisher/index.ts";
import { createGui } from "../extensions/finisher/src/gui.ts";

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const toolCall = (id, command, output) => [encodeToolEvent({ phase: "start", id, name: "bash", args: { command } }), encodeToolEvent({ phase: "end", id, name: "bash", output, isError: false, durationMs: 40 })];

const sessionPage = ({ logs, rows = 24, columns = 100 }) => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-session-page-"));
	const runs = logs.map((lines, i) => {
		const logPath = join(cwd, `run-${i}.log`);
		writeFileSync(logPath, lines.join("\n"));
		return { role: i === 0 ? "swarm" : "verifier", ok: false, summary: "", at: 1_000 + i, startedAt: 1_000 + i, status: "running", slotId: `s${i}`, logPath, prompt: `task ${i}` };
	});
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: runs });
	const gui = createGui({ pi: {} });
	const persisted = [];
	const viewers = createViewers({
		pi: {},
		get state() {
			return box.get();
		},
		finisherCustom: gui.finisherCustom,
		OVERLAY_XL: gui.OVERLAY_XL,
		scrollKeyAction: gui.scrollKeyAction,
		persist: () => persisted.push(box.get().toolOutputExpanded),
	});
	let component;
	const tui = { terminal: { columns, rows }, requestRender: () => {} };
	viewers.openAgentsViewer({ cwd, mode: "tui", hasUI: true, ui: { notify: () => {}, custom: (factory) => (component = factory(tui, theme, {}, () => {}), new Promise(() => {})) } });
	return {
		columns,
		runs,
		persisted,
		render: () => component.render(columns).map(strip),
		key: (data) => component.handleInput(data),
		dispose: () => {
			component.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
};

test("the agent session page scrolls its log to the last line at every terminal size", () => {
	const log = Array.from({ length: 300 }, (_, i) => `log line ${i}`);
	for (const [rows, columns] of [[14, 80], [24, 100], [40, 160]]) {
		const page = sessionPage({ logs: [log], rows, columns });
		const drawn = new Set();
		const sweep = (out) => {
			for (const hit of out.join("\n").matchAll(/log line (\d+)/g)) drawn.add(Number(hit[1]));
			return out;
		};
		const opened = sweep(page.render());
		assert.ok(opened.some((l) => l.includes("log line 299")), `${rows}x${columns}: a live log opens on its newest line`);
		page.key("\x1b[H");
		const top = sweep(page.render());
		assert.ok(top.some((l) => l.includes("task — what this agent was told")), `${rows}x${columns}: Home goes back to the head of the session, the task it was given`);
		assert.equal(top.some((l) => l.includes("log line 299")), false, `${rows}x${columns}: the last line is off the first page`);
		for (let i = 0; i < 400; i++) {
			page.key("\x1b[6~");
			sweep(page.render());
		}
		assert.equal(drawn.size, 300, `${rows}x${columns}: paging down draws every line, only ${drawn.size} were drawn`);
		page.key("\x1b[F");
		assert.ok(page.render().some((l) => l.includes("log line 299")), `${rows}x${columns}: End lands on the last line`);
		page.key("\x1b[A");
		assert.ok(page.render().some((l) => l.includes("log line 298")), `${rows}x${columns}: a step up moves exactly one line, it never jumps away from the end`);
		page.dispose();
	}
});

test("the agent page keeps its own keys: digits jump, arrows page between agents, t toggles tool output, and each keeps its own scroll", () => {
	const page = sessionPage({ logs: [[...toolCall("c1", "npm test", "5 pass"), ...Array.from({ length: 200 }, (_, i) => `first ${i}`)], Array.from({ length: 200 }, (_, i) => `second ${i}`)] });
	const seen = () => page.render().join("\n");
	assert.ok(seen().includes("first 199"), "the live agent opens on the end of its own log");
	page.key("2");
	const second = page.render();
	assert.ok(second.some((l) => l.includes("second 199")), "digit 2 jumps to the second agent, and that page opens on its own end");
	assert.equal(second.some((l) => l.includes("first 199")), false, "and the first agent's log is not on it");
	page.key("\x1b[5~");
	page.key("\x1b[5~");
	const scrolled = page.render();
	assert.equal(scrolled.some((l) => l.includes("second 199")), false, "paging up inside the second agent leaves its end behind");
	page.key("1");
	assert.ok(page.render().some((l) => l.includes("first 199")), "jumping back returns the first agent to its own position");
	page.key("\x1b[C");
	assert.ok(page.render().some((l) => l.includes("second ")), "the right arrow pages to the next agent");
	page.key("\x1b[D");
	assert.ok(page.render().some((l) => l.includes("first ")), "and the left arrow pages back");
	assert.ok(page.render().some((l) => l.includes("show tool output")) || page.render().some((l) => l.includes("t =")), "the tool toggle is advertised on the page");
	page.key("t");
	assert.equal(page.persisted.length, 1, "t toggles the shared tool-output setting exactly once per press");
	page.key("t");
	assert.deepEqual(page.persisted, [true, false], "the toggle flips and is persisted each time");
	page.dispose();
});

test("every page of the session keeps its own offset, so switching agents never moves the other one", () => {
	const page = sessionPage({ logs: [Array.from({ length: 200 }, (_, i) => `a${i}`), Array.from({ length: 200 }, (_, i) => `b${i}`)] });
	page.key("1");
	for (let i = 0; i < 5; i++) page.key("\x1b[5~");
	const firstAt = page.render().join("\n");
	assert.equal(firstAt.includes("a199"), false, "the first page is scrolled away from its end");
	page.key("2");
	const secondAt = page.render().join("\n");
	assert.ok(secondAt.includes("b199"), "the second page still sits at its end, it was never scrolled");
	page.key("1");
	assert.ok(page.render().join("\n").includes("a199") === false, "and the first page kept the offset it was left at");
	page.dispose();
});

test("no session line is ever drawn wider than the page, however long the log line is", () => {
	const logs = [["x".repeat(500), "short line"]];
	for (const columns of [40, 80, 120]) {
		const page = sessionPage({ logs, columns });
		for (const line of page.render()) assert.ok(visibleWidth(line) <= columns, `a ${visibleWidth(line)}-wide line in a ${columns}-column page`);
		assert.ok(page.render().join("\n").includes("short line"), `width ${columns}: the line after the long one still follows`);
		page.dispose();
	}
});
