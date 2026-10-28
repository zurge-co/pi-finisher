import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createLogReader,
	LOG_WAIT_LINE,
	orderedSessionRuns,
	recordSteerOnRun,
	runningRunFor,
	sessionBody,
	sessionKeyLine,
	sessionLabel,
	sessionTabs,
	startSessionIndex,
	stepSessionIndex,
	SESSION_TASK_LINES,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const run = (role, extra = {}) => ({ role, ok: false, summary: "", at: 1_000, startedAt: 1_000, status: "running", ...extra });

test("agent paging is a total order: every run appears exactly once, live first, then the newest finished", () => {
	const runs = [run("coder", { at: 1 }), { ...run("coder", { at: 2, slotId: "s2" }), status: "done", ok: true }, run("coder", { at: 3 }), { ...run("coder", { at: 4 }), status: "failed" }];
	const ordered = orderedSessionRuns(runs);
	assert.equal(ordered.length, runs.length, "paging must never lose or duplicate an agent");
	assert.deepEqual(ordered.map((r) => r.at), [1, 3, 4, 2], "live agents first in start order, then finished newest first");
	assert.deepEqual([...runs], runs, "ordering must not mutate the run list");
});

test("stepSessionIndex wraps in both directions and returns to the start after a full turn", () => {
	for (const total of [1, 2, 3, 7]) {
		for (let start = 0; start < total; start++) {
			let i = start;
			for (let n = 0; n < total; n++) i = stepSessionIndex(i, total, 1);
			assert.equal(i, start, `total ${total}: a full rightward turn must return to ${start}`);
			i = start;
			for (let n = 0; n < total; n++) i = stepSessionIndex(i, total, -1);
			assert.equal(i, start, `total ${total}: a full leftward turn must return to ${start}`);
			assert.equal(stepSessionIndex(start, total, 1), (start + 1) % total);
			assert.equal(stepSessionIndex(start, total, -1), (start - 1 + total) % total);
		}
	}
	assert.equal(stepSessionIndex(5, 0, 1), 0, "no agents means no crash");
});

test("the page opens on a live agent when one exists, and the label always names which agent it is", () => {
	const runs = [run("coder", { at: 1, slotId: "s1" }), { ...run("coder", { at: 2, slotId: "s2" }), status: "done", ok: true }];
	assert.equal(startSessionIndex(runs), 0, "a live agent is shown first");
	assert.equal(startSessionIndex([{ ...run("coder", { at: 2 }), status: "done", ok: true }]), 0);
	for (const width of [40, 80, 120]) {
		const label = sessionLabel(runs[0], 0, 2, width, 96_000);
		assert.match(label, /^1\/2 · CODER · ▶ 1m35s/, `the label carries position, role and state: ${label}`);
		assert.match(label, /s1|\(ladder\)|steer/);
		assert.ok(visibleWidth(label) <= Math.max(20, width), "the label never overflows the page");
		assert.equal(label.includes("\n"), false, "the label is one line");
	}
	assert.match(sessionLabel({ ...run("coder"), status: "done", ok: true }, 1, 2, 80), /^2\/2 · CODER · ✓ done/);
	assert.match(sessionLabel({ ...run("coder"), status: "failed" }, 0, 1, 80), /✗ failed/);
	assert.equal(sessionKeyLine(3).includes("←/→"), true, "with several agents the arrows are advertised");
	assert.equal(sessionKeyLine(1).includes("←/→"), false, "with one agent the arrows would lie");
});

test("one page shows all three things: the task it was given, what was steered in, and the live session output", () => {
	const target = run("coder", { prompt: "fix the scheduler bound\nsecond line of the task", logPath: "/tmp/x.log" });
	const runs = [target];
	assert.equal(recordSteerOnRun({ subagentRuns: runs }, "coder", "steer", "the bound is 16, not 5"), true);
	assert.equal(recordSteerOnRun({ subagentRuns: runs }, "coder", "followUp", "then run the suite"), true);
	assert.equal(recordSteerOnRun({ subagentRuns: runs.filter((r) => r.status !== "running") }, "coder", "steer", "x"), false, "a finished agent cannot be steered, so nothing is recorded");
	assert.equal(runningRunFor(runs, "verifier"), undefined);

	const body = sessionBody(target, ["thinking…", "⚙ bash", "$ npm test", "ok"], 80);
	const text = body.join("\n");
	assert.match(text, /▸ task/);
	assert.match(text, /fix the scheduler bound/);
	assert.match(text, /▸ steered \(2\)/);
	assert.match(text, /→ steer: the bound is 16, not 5/);
	assert.match(text, /↳ follow-up: then run the suite/);
	assert.match(text, /▸ session/);
	assert.match(text, /\$ npm test/, "the live output is on the page, not just in the status row");
	for (const line of body) assert.ok(visibleWidth(line) <= 90, `"${line}" overflows`);
});

test("a long task is bounded on the page instead of pushing the output off screen", () => {
	const longTask = Array.from({ length: 200 }, (_, i) => `task line ${i}`).join("\n");
	const body = sessionBody(run("coder", { prompt: longTask }), ["x"], 80);
	const taskPart = body.slice(0, body.indexOf(body.find((l) => l.startsWith("▸ session"))));
	assert.ok(taskPart.length <= SESSION_TASK_LINES + 2, `the task preview must stay bounded, got ${taskPart.length}`);
	assert.match(taskPart.join("\n"), /more line\(s\)/);
});

test("the page is reachable from one keypress and keeps the whole session on disk, not in the status row", () => {
	const views = readFileSync(join(here, "extensions/finisher/src/viewers.ts"), "utf8");
	assert.match(views, /Key\.left/, "← must switch to the previous agent");
	assert.match(views, /Key\.right/, "→ must switch to the next agent");
	assert.match(views, /sessionTitle/, "the page is labelled with the agent it shows");
	assert.match(views, /sessionBody/, "the page renders task + steers + output");
	const cmds = readFileSync(join(here, "extensions/finisher/src/commands.ts"), "utf8");
	assert.match(cmds, /registerShortcut\(Key\.ctrl\("_"\)[\s\S]*openAgentsViewer/, "one key opens the live session directly");
	assert.ok(!/finisherPick/.test(cmds.slice(cmds.indexOf("registerShortcut"), cmds.indexOf('registerCommand("finisher"'))), "opening a session must not go through a picker first");
	const launch = readFileSync(join(here, "extensions/finisher/src/subagent-launch.ts"), "utf8");
	assert.match(launch, /run\.prompt = prompt/, "the input a sub-agent was given is kept for its page");
	const rpc = readFileSync(join(here, "extensions/finisher/src/subagent-rpc.ts"), "utf8");
	assert.match(rpc, /markSteerInLog/, "a steer is written into the run's own log so the page shows it in place");
	const widget = readFileSync(join(here, "extensions/finisher/src/panel-widget.ts"), "utf8");
	assert.match(widget, /handleMouse/, "the HUD rows are clickable, so the page opens on the agent that was clicked");
	assert.match(widget, /openAgentSession/, "a click opens that agent, not whichever one happens to be first");
	assert.match(views, /sessionTabs/, "the page lists the other agents next to the one on screen");
	assert.match(views, /\/\^\[1-9\]\$\//, "digits jump straight to an agent");
});

test("outside the TUI the same page degrades to a readable summary instead of opening a dialog", async () => {
	const { createViewers, createStateBox } = await import("../extensions/finisher/index.ts");
	const state = createStateBox({
		phase: "implementation",
		turnsUsed: 0,
		tokensUsed: 0,
		escalations: [],
		trajectoryFlags: [],
		subagentRuns: [
			run("coder", { slotId: "slot1", model: "a/one", prompt: "slice s1: fix the bound", logPath: "/repo/.finisher/subagents/s1.log", steers: [{ at: 1, mode: "steer", message: "m" }] }),
			{ ...run("coder", { at: 2, slotId: "slot2" }), status: "done", ok: true, prompt: "prove c1" },
		],
	});
	let opened = 0;
	const notes = [];
	const viewers = createViewers({
		pi: {},
		get state() { return state.get(); },
		finisherCustom: async () => {
			opened++;
			return null;
		},
	});
	await viewers.openAgentsViewer({ cwd: "/repo", mode: "rpc", ui: { notify: (m) => notes.push(m) } });
	assert.equal(opened, 0, "a dialog cannot exist outside the TUI");
	const text = notes.join("\n");
	assert.match(text, /1\/2/);
	assert.match(text, /task: slice s1: fix the bound/);
	assert.match(text, /steered 1×/);
	assert.match(text, /\.finisher\/subagents\/s1\.log/, "the log path is what a non-TUI user needs to open it themselves");

	await viewers.openAgentsViewer({ cwd: "/repo", mode: "rpc", ui: { notify: (m) => notes.push(m) } });
	const empty = createStateBox({ phase: "requirements", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const quiet = [];
	await createViewers({ pi: {}, get state() { return empty.get(); }, finisherCustom: async () => null }).openAgentsViewer({ cwd: "/repo", mode: "tui", ui: { notify: (m) => quiet.push(m) } });
	assert.match(quiet.join("\n"), /no sub-agent has run/);
});

test("every page names itself and lists the others, so an arrow key is never a blind switch", () => {
	const runs = [
		run("coder", { at: 1, slotId: "s1" }),
		{ ...run("coder", { at: 2, slotId: "s2" }), status: "done", ok: true },
		run("coder", { at: 3, slotId: "s3" }),
	];
	for (let current = 0; current < runs.length; current++) {
		const tabs = sessionTabs(runs, current, 200);
		assert.equal(tabs.split("[").length - 1, 1, `exactly one page is the current one: ${tabs}`);
		assert.equal(tabs.split("]").length - 1, 1);
		const onScreen = tabs.slice(tabs.indexOf("[") + 1, tabs.indexOf("]"));
		assert.ok(onScreen.startsWith(`${current + 1}:`), `the bracketed tab must be the page on screen: ${tabs}`);
		for (let i = 1; i <= runs.length; i++) assert.ok(tabs.includes(`${i}:`), `agent ${i} is listed: ${tabs}`);
		assert.match(tabs, /CODER/, "the role is on the tab, so no page hides what it is");
		for (const slot of ["s1", "s2", "s3"]) assert.ok(tabs.includes(slot), `the tab names its own slice: ${tabs}`);
		for (const width of [20, 40, 60, 120]) assert.ok(visibleWidth(sessionTabs(runs, current, width)) <= Math.max(20, width), `width ${width} overflows`);
	}
	assert.match(sessionKeyLine(3), /1-9 jump/, "the digits are advertised when there is something to jump to");
	assert.equal(sessionKeyLine(1).includes("1-9"), false, "with one agent the digits would lie");
});

test("the tab strip keeps the page you are on, and never skips one between the first and last it shows", () => {
	const roles = ["coder", "coder"];
	for (const n of [1, 2, 3, 4, 8]) {
		const runs = Array.from({ length: n }, (_, i) => run(roles[i % 2], { at: i + 1, slotId: `s${i}`, model: "provider/model-name" }));
		for (let current = 0; current < n; current++) {
			for (const width of [20, 24, 30, 40, 60, 80, 120, 200]) {
				const tabs = sessionTabs(runs, current, width);
				const where = `n=${n} page=${current + 1} width=${width}`;
				assert.ok(visibleWidth(tabs) <= Math.max(20, width), `${where}: "${tabs}" is ${visibleWidth(tabs)} wide`);
				assert.equal(tabs.split("[").length - 1, 1, `${where}: exactly one tab is current — ${tabs}`);
				assert.equal(tabs.split("]").length - 1, 1, `${where}: the current tab is closed — ${tabs}`);
				const marked = tabs.slice(tabs.indexOf("[") + 1, tabs.indexOf("]"));
				assert.ok(marked.startsWith(`${current + 1}:`), `${where}: the bracket must be the page on screen — ${tabs}`);
				const listed = [...tabs.matchAll(/(?:^|[^\d])(\d+):/g)].map((m) => Number(m[1]));
				assert.ok(listed.includes(current + 1), `${where}: the page on screen is always listed — ${tabs}`);
				for (let i = 1; i < listed.length; i++) assert.equal(listed[i], listed[i - 1] + 1, `${where}: a shown window never skips an agent — ${tabs}`);
			}
		}
	}
	const eight = Array.from({ length: 8 }, (_, i) => run("coder", { at: i + 1, slotId: `s${i}` }));
	assert.equal([...sessionTabs(eight, 3, 200).matchAll(/(?:^|[^\d])(\d+):/g)].length, 8, "a wide page lists every agent");
});

test("one frame stats a log once and reads it once, whatever the page asks it for", () => {
	const stats = [];
	const reads = [];
	let size = 10;
	const reader = createLogReader({
		stat: (path) => {
			stats.push(path);
			return { size, mtimeMs: 5 };
		},
		read: (path) => {
			reads.push(path);
			return [`line for ${path}`];
		},
	});
	const target = { logPath: "/repo/a.log" };
	const first = reader(target);
	assert.deepEqual(first, ["line for /repo/a.log"]);
	reader.beginFrame();
	for (let i = 0; i < 6; i++) {
		assert.deepEqual(reader(target), first, "the body, the key line and the footer all see the same lines");
		assert.equal(reader.logKeyOf(target), "/repo/a.log@10:5");
	}
	assert.equal(reads.length, 1, "an unchanged log is read exactly once, not once per widget that asks");
	assert.equal(stats.length, 2, "one stat per frame: the frame reads the file's identity, not the file");

	reader.beginFrame();
	size = 11;
	assert.equal(reader.logKeyOf(target), "/repo/a.log@11:5", "the key carries the size, so a grow is visible");
	assert.deepEqual(reader(target), ["line for /repo/a.log"], "a grown log is re-read");
	assert.equal(reads.length, 2);

	reader.beginFrame();
	assert.deepEqual(reader({}), [LOG_WAIT_LINE], "no log yet is a notice, not a read");
	assert.equal(reader.logKeyOf({}), "none");
	reader.invalidate();
	reader.beginFrame();
	reader(target);
	assert.equal(reads.length, 3, "invalidate drops the cache so the next frame reads again");
	assert.equal(stats.length, 4, "an explicit invalidate is not a frame of its own");
});
