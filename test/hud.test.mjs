import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { HUD_MARK, hudActive, hudIdleLine, hudLines } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;

const run = (role, extra = {}) => ({ role, status: "running", startedAt: 1_000, at: 1_000, ...extra });
const phases = [
	{ id: "p-one", text: "read the parser", round: 0, addedAt: 1_000 },
	{ id: "p-two", text: "rewrite the retry policy", round: 0, addedAt: 1_000 },
	{ id: "p-three", text: "prove it with a command", round: 0, addedAt: 1_000 },
];
const goal = (extra = {}) => ({ goal: "ship the new HUD", confirmedAt: 1_000, phases, lap: 2, lapAt: 2_000, lapMs: [1_000], ...extra });

test("no HUD line ever exceeds the terminal width, for any width and any tail", () => {
	const runs = [run("swarm", { slotId: "slot1", model: "provider/a-very-long-model-name", streamTail: "x".repeat(400) }), run("verifier")];
	for (let width = 8; width <= 200; width++) {
		for (const input of [{ runs, width }, { runs: [], width }, { runs, width, goal: goal() }, { runs: [], width, goal: goal({ goal: "g".repeat(500) }) }]) {
			for (const line of hudLines({ now: 90_000, ...input })) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}" is ${visibleWidth(line)} wide`);
			}
		}
	}
});

test("the box is drawn only while the run is live, and idle is exactly one line", () => {
	assert.equal(hudActive({ runs: [], width: 80, goal: goal({ doneAt: 5, outcome: "verified" }) }), false, "a finished goal is not live work");
	assert.equal(hudActive({ runs: [], width: 80, goal: goal() }), true, "an open goal keeps the HUD up");
	assert.equal(hudActive({ runs: [run("swarm")], width: 80 }), true);
	const idle = hudLines({ runs: [], width: 80 });
	assert.equal(idle.length, 1, "an idle session costs one line, not a panel");
	assert.equal(idle[0], HUD_MARK, "an idle session says only its mark — no clock, no stage word, no lamp");
	assert.ok(!/finisher|total time/i.test(idle[0]), "the HUD names neither the extension nor a \"total time\" label");
	assert.ok(!/turns|tok/.test(idle[0]), "the cost counters moved to the footer, never the HUD");
	const won = hudLines({ runs: [], width: 80, goal: goal({ doneAt: 62_000, outcome: "verified" }) });
	assert.equal(won.length, 1, "a finished goal closes back to one line");
	assert.match(won[0], /^▚ 1:01 · 3 laps · pit /, "the total race time survives the win");
	const lost = hudLines({ runs: [], width: 80, goal: goal({ doneAt: 62_000, outcome: "halted" }) });
	assert.match(lost[0], /^▚ 1:01 · 1\/3 laps · pit /, "a lost goal keeps its clock and its lap tally, never a result word");
	assert.equal(hudIdleLine({ runs: [], width: 20 }).length > 0, true);
});

test("the frame is closed and carries one row per live agent, never the old spec/phase status line", () => {
	const runs = [run("swarm", { slotId: "slot1", model: "m/one" }), run("swarm", { slotId: "slot2", model: "m/two" }), run("verifier")];
	const lines = hudLines({ runs, width: 100, now: 45_000, goal: goal() });
	assert.match(lines[0], /^╭─/);
	assert.match(lines[lines.length - 1], /^╰─+╯$/);
	assert.equal(lines.filter((l) => /^│ /.test(l)).length, 1 + 3, "one goal line plus one row per live agent");
	assert.match(lines.join("\n"), /3 live/);
	assert.match(lines[0], /^╭─ ▚ 0:44 ─ /, "the first line is the mark and the goal's clock, then the liveness hint");
	assert.ok(!/LAP|VERIFY|PLAN|READY|P1|DNF|[●○✕]/.test(lines[0]), `no stage word and no lamp on the border: ${lines[0]}`);
	const oldStatus = readFileSync(join(here, "extensions/finisher/src/panel-widget.ts"), "utf8");
	assert.ok(!/state\.phase|state\.spec|unapproved/.test(oldStatus), "the old spec/phase status bar is gone");
	assert.match(oldStatus, /hudRender|styledHudLines|hudLines/, "the widget must render through the HUD module instead of building its own line");
});

test("the HUD is a bounded frame: a hundred finished runs still fit in the row budget", () => {
	const runs = Array.from({ length: 100 }, (_, i) => ({ role: `r${i}`, status: "done", at: i, summary: "s" }));
	const lines = hudLines({ runs: [...runs, run("swarm")], width: 90 });
	assert.ok(lines.length <= 12, `the box must stay small, got ${lines.length} lines`);
	assert.match(lines.join("\n"), /1 live/);
});

test("the widget pi actually calls renders at the width pi gives it, collapses to one line when idle, and never re-sends an unchanged frame", async () => {
	const { createPanelWidget, createStateBox } = await import("../extensions/finisher/index.ts");
	const box = createStateBox({ phase: "requirements", turnsUsed: 3, tokensUsed: 12_000, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const sent = [];
	const theme = { fg: (_token, text) => text };
	const statuses = [];
	const ctx = { hasUI: true, ui: { setWidget: (key, factory, opts) => sent.push({ key, factory, opts }), setStatus: (key, text) => statuses.push({ key, text }) } };
	const widget = createPanelWidget({ pi: {}, get state() { return box.get(); }, persist: () => {} });

	widget.updateWidget(ctx);
	widget.updateWidget(ctx);
	assert.equal(sent.length, 1, "an unchanged frame is not pushed to pi twice");
	assert.equal(sent[0].key, "finisher");
	assert.equal(sent[0].opts.placement, "belowEditor", "the HUD sits under the editor, not above the transcript");
	const render = () => sent.at(-1).factory({}, theme).render(72);
	assert.equal(render().length, 1, "an idle session costs one row");
	assert.equal(widget.widgetVisible(), false);

	box.get().subagentRuns.push({ role: "swarm", ok: false, summary: "", at: Date.now(), startedAt: Date.now() - 5_000, status: "running", slotId: "slot1", model: "a/one", streamTail: "working" });
	widget.updateWidget(ctx);
	assert.ok(render().length > 1, "a live agent opens the box");
	assert.equal(widget.widgetVisible(), true);
	for (const width of [40, 72, 140]) for (const line of sent.at(-1).factory({}, theme).render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);

	box.get().subagentRuns[0].status = "done";
	widget.updateWidget(ctx);
	assert.equal(sent.at(-1).factory({}, theme).render(72).length, 1, "the box closes again when the last agent finishes");
	assert.equal(widget.widgetVisible(), false);
});

test("the stage paints the whole frame and a row keeps only its own mark: a running lap leaves no accent behind", async () => {
	const { hudFrames, hudPaint, raceStageToken, raceState } = await import("../extensions/finisher/index.ts");
	const runs = [run("swarm", { slotId: "slot1", model: "m/one" })];
	const phasesFor = (extra = {}) => goal(extra);
	const cases = [
		["plan", { runs: [], goal: { goal: "g", confirmedAt: 1_000 }, now: 30_000 }],
		["run", { runs, goal: phasesFor(), now: 30_000 }],
		["verify", { runs: [], goal: phasesFor({ lap: 4, lapAt: 20_000 }), now: 30_000 }],
		["win", { runs: [], goal: phasesFor({ doneAt: 62_000, outcome: "verified" }), now: 62_000 }],
		["dnf", { runs: [], goal: phasesFor({ doneAt: 62_000, outcome: "halted" }), now: 62_000 }],
		["idle", { runs: [], now: 30_000 }],
	];
	for (const [label, input] of cases) {
		const frames = hudFrames({ ...input, width: 90 });
		const race = raceState(input);
		assert.equal(race.phase, label, `${label}: the fixture reaches the phase it is named for`);
		const stage = raceStageToken(race) ?? "dim";
		const tokens = [];
		const painted = hudPaint(frames, { fg: (token, text) => (tokens.push(token), `\u001b[35m${text}\u001b[0m`) }, race);
		assert.equal(painted.length, frames.length, `${label}: one painted line per frame`);
		for (let i = 0; i < frames.length; i++) {
			assert.equal(stripTerminalSequences(painted[i]), frames[i].text, `${label}: the paint is styling only`);
			assert.equal(visibleWidth(painted[i]), visibleWidth(frames[i].text), `${label}: and it occupies the same columns`);
		}
		assert.equal(tokens[0], stage, `${label}: the first line takes the stage's colour`);
		assert.equal(tokens.at(-1), stage, `${label}: the last line too`);
		for (const token of tokens) assert.ok([stage, "success", "error"].includes(token), `${label}: no line paints a colour the state does not hold: ${token}`);
		if (label !== "run") continue;
		assert.deepEqual([...new Set(tokens)], ["warning"], `a running lap is one colour end to end, never the accent: ${tokens}`);
		const mark = frames.findIndex((f) => f.text.includes("▶"));
		assert.ok(mark > 0, "the live agent still has its ▶ row");
		assert.equal(tokens[mark], stage, "the ▶ of a running sub-agent carries the stage's colour, not the accent");
	}
});

test("the report row is painted by the report's own outcome, never one fixed colour", async () => {
	const { hudFrames, hudPaint, raceState } = await import("../extensions/finisher/index.ts");
	const input = (outcome) => ({ runs: [run("swarm", { slotId: "s1" })], width: 100, now: 30_000, goal: goal(), report: { outcome, laps: 3, at: 1, goal: "ship the new HUD" } });
	const expected = { verified: "success", "needs-human": "warning", halted: "error" };
	for (const [outcome, token] of Object.entries(expected)) {
		const frames = hudFrames(input(outcome));
		const report = frames.filter((f) => f.kind === "report");
		assert.equal(report.length, 1, `${outcome}: the report keeps its own row`);
		const tokens = [];
		hudPaint(report, { fg: (t, text) => (tokens.push(t), text) }, raceState(input(outcome)));
		assert.deepEqual(tokens, [token], `${outcome}: the row takes that outcome's colour`);
	}
	assert.equal(new Set(Object.values(expected)).size, 3, "three outcomes, three colours: the row can never be painted one fixed colour");
});

test("with no goal at all the HUD is one dim line and nothing else", async () => {
	const { hudFrames, hudPaint, raceState } = await import("../extensions/finisher/index.ts");
	const input = { runs: [], width: 100, now: 5_000 };
	const frames = hudFrames(input);
	assert.equal(frames.length, 1, "no goal and no agent is a single line");
	const tokens = [];
	hudPaint(frames, { fg: (t, text) => (tokens.push(t), text) }, raceState(input));
	assert.deepEqual(tokens, ["dim"], "the idle line is dim, nothing else");
	const bare = [];
	hudPaint(frames, { fg: (t, text) => (bare.push(t), text) });
	assert.deepEqual(bare, ["dim"], "a caller that passes no race at all still gets the idle colour");
});

test("every painted HUD line points at the agent it draws, so a click can never land on the wrong one", async () => {
	const { hudHitMap, hudRender } = await import("../extensions/finisher/index.ts");
	const runs = [run("swarm", { slotId: "s1", model: "m/one" }), run("verifier", { slotId: "v1", model: "m/two" }), run("swarm", { slotId: "s3" })];
	const theme = { fg: (_token, text) => text };
	for (let width = 8; width <= 160; width++) {
		const input = { runs, width, now: 4_000 };
		const lines = hudLines(input);
		const hits = hudHitMap(input);
		assert.equal(hits.length, lines.length, `width ${width}: every painted line needs exactly one hit slot`);
		assert.deepEqual(hudRender(input, theme).hits, hits, `width ${width}: the painted frame and the bare frame must agree`);
		const agents = hits.map((hit, y) => ({ hit, line: lines[y] })).filter((e) => e.hit !== undefined);
		assert.equal(agents.length, runs.length, `width ${width}: one clickable row per live agent`);
		assert.deepEqual(agents.map((e) => e.hit), [0, 1, 2], `width ${width}: rows point back at their own run, in row order`);
	}
	const wide = { runs, width: 120, now: 4_000 };
	const lines = hudLines(wide);
	const hits = hudHitMap(wide);
	for (const [y, hit] of hits.entries()) if (hit !== undefined) assert.ok(lines[y].includes(runs[hit].slotId), `row ${y} must name its own agent: ${lines[y]}`);
	assert.equal(hits[0], undefined, "the top border is not a target");
	assert.equal(hits.at(-1), undefined, "the bottom border is not a target");
});

test("clicking an agent's row opens that agent's page, and clicking the frame does nothing", async () => {
	const { createPanelWidget, createStateBox, hudHitMap } = await import("../extensions/finisher/index.ts");
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const sent = [];
	const opened = [];
	const widget = createPanelWidget({
		pi: {},
		get state() {
			return box.get();
		},
		openAgentSession: async (_ctx, at) => {
			opened.push(at.at);
			return null;
		},
	});
	const statuses = [];
	const ctx = { hasUI: true, ui: { setWidget: (key, factory, opts) => sent.push({ key, factory, opts }), setStatus: (key, text) => statuses.push({ key, text }) } };
	box.get().subagentRuns.push({ role: "swarm", ok: false, summary: "", at: 11, startedAt: 1_000, status: "running", slotId: "s1" });
	box.get().subagentRuns.push({ role: "verifier", ok: false, summary: "", at: 22, startedAt: 1_000, status: "running", slotId: "v1" });
	widget.updateWidget(ctx);
	const component = sent.at(-1).factory({}, { fg: (_token, text) => text });
	component.render(120);
	const hits = hudHitMap({ runs: box.get().subagentRuns, width: 120, now: Date.now() });
	const click = (y) => component.handleMouse({ type: "click", y, x: 0, screenX: 0, screenY: y, button: "left", shift: false, alt: false, ctrl: false, width: 120, height: hits.length });
	assert.deepEqual(click(0), undefined, "the frame is not a target");
	assert.equal(opened.length, 0);
	const [first, second] = [hits.indexOf(0), hits.indexOf(1)];
	click(first);
	click(second);
	assert.deepEqual(opened, [11, 22], "each click opens the agent whose row is under it");
	assert.deepEqual(component.handleMouse({ type: "move", y: second, x: 0, screenX: 0, screenY: second, button: "none", shift: false, alt: false, ctrl: false, width: 120, height: hits.length }), undefined, "hovering opens nothing");
});

test("no warning tally anywhere in the HUD: not on the box, not on the idle line", async () => {
	const { hudLines, hudIdleLine, hudFrames } = await import("../extensions/finisher/index.ts");
	const runs = [{ role: "swarm", status: "running", startedAt: 1, at: 1, slotId: "slot1" }];
	const goal = { goal: "g", confirmedAt: 1_000, phases: [{ id: "p-a", text: "a", round: 0, addedAt: 1_000 }], lap: 1, lapAt: 5_000 };
	const noisy = { runs, goal, width: 120, flags: 2, hygiene: 1, escalations: 3 };
	const quiet = { runs, goal, width: 120 };
	assert.deepEqual(hudLines(noisy), hudLines(quiet), "the counters are not rendered at all, so they cannot change a single line");
	assert.deepEqual(hudFrames(noisy), hudFrames(quiet));
	for (const line of [...hudLines(noisy), hudIdleLine(noisy)]) assert.ok(!/⚠|🧹|🚨/.test(line), `a warning glyph must never appear: ${line}`);
});
