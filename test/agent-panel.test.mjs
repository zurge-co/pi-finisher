import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, elapsedLabel, formatPanelRow, hudLines, liveRuns, panelLines, panelRows, panelTickMs, sessionTabs, streamTail } from "../extensions/finisher/index.ts";

const run = (role, extra = {}) => ({ role, status: "running", startedAt: 1_000, at: 1_000, ...extra });

test("every running agent gets its own row at the same time — none is hidden behind a picker", () => {
	const runs = [run("coder", { model: "m/one", slotId: "s1" }), run("coder", { model: "m/two", slotId: "s2" }), run("grader")];
	const rows = panelRows(runs, { now: 3_000 });
	assert.equal(rows.length, 3);
	assert.deepEqual(rows.map((r) => r.slot).filter(Boolean), ["s1", "s2"]);
	assert.deepEqual(rows.map((r) => r.model).filter(Boolean), ["m/one", "m/two"]);
	assert.ok(rows.every((r) => r.state === "▶"));
	assert.equal(panelLines(runs, { now: 3_000 })[0], "AGENTS ▸ 3 running");
});

test("identical role and model still produce distinguishable row tags", () => {
	const rows = panelRows([run("coder", { model: "m/one" }), run("coder", { model: "m/one" }), run("coder", { model: "m/one" })]);
	assert.deepEqual(rows.map((r) => r.tag), ["CODER", "CODER2", "CODER3"]);
});

test("a live row carries elapsed time, a finished row carries its summary", () => {
	const rows = panelRows([run("a", { startedAt: 0, summary: "ignored" }), { role: "b", status: "done", at: 0, summary: "compiled the spec" }], { now: 95_000 });
	assert.equal(rows[0].elapsed, "1m35s");
	assert.equal(rows[0].tail, undefined);
	assert.equal(rows[1].elapsed, undefined);
	assert.equal(rows[1].tail, "compiled the spec");
	assert.equal(rows[1].state, "✓");
});

test("the panel keeps only a bounded tail of finished runs and can hide them", () => {
	const finished = Array.from({ length: 10 }, (_, i) => ({ role: `r${i}`, status: "done", at: i, summary: "s" }));
	assert.equal(panelRows(finished, { finishedKeep: 3 }).length, 3);
	assert.deepEqual(panelRows(finished, { finishedKeep: 3 }).map((r) => r.role), ["r7", "r8", "r9"]);
	assert.equal(panelRows(finished, { showFinished: false }).length, 0);
	assert.deepEqual(panelLines([], {}), []);
});

test("a row never exceeds the terminal width, and the tail is what gets clipped", () => {
	const row = formatPanelRow({ tag: "CODER", role: "coder", state: "▶", slot: "s1", model: "provider/a-long-model-name", elapsed: "12s", tail: "x".repeat(200) }, 60, 80);
	assert.ok(row.length <= 60, `row is ${row.length} chars`);
	assert.match(row, /^CODER +▶ coder/);
	assert.match(row, /provider\/a-long-model-name/);
});

test("elapsed formatting is monotonic and never negative", () => {
	assert.deepEqual([0, 999, 1_000, 59_500, 60_000, 3_599_000].map(elapsedLabel), ["0s", "1s", "1s", "1m00s", "1m00s", "59m59s"]);
	assert.equal(elapsedLabel(-5_000), "0s");
});

test("clip flattens newlines so a multi-line stream cannot break the panel layout", () => {
	assert.equal(clip("a\nb\tc  d", 40), "a b c d");
	assert.equal(clip("abcdef", 4), "abc…");
	assert.equal(clip("abc", 0), "");
	assert.equal(streamTail("x".repeat(500), 10).length, 10);
});

test("panels tick faster while several agents run, and liveRuns counts exactly the running ones", () => {
	assert.equal(panelTickMs(5), 1_000);
	assert.equal(panelTickMs(1), 2_000);
	assert.equal(panelTickMs(0), 2_000);
	assert.equal(liveRuns([run("a"), { role: "b", status: "done", at: 0 }, run("c")]).length, 2);
});

test("fan-out work is labelled CODER on every surface, whatever case the role arrives in", () => {
	const roles = ["swarm", "coder", "Swarm", "CODER", " swarm "];
	const runs = roles.map((role, i) => run(role, { slotId: `s${i}`, model: `m/${i}` }));
	assert.deepEqual(panelRows(runs, { now: 2_000 }).map((r) => r.tag.replace(/\d+$/, "")), roles.map(() => "CODER"));
	const surfaces = [...panelLines(runs, { now: 2_000 }), ...hudLines({ runs, width: 100, now: 2_000 }), sessionTabs(runs, 0, 200)];
	for (const line of surfaces) {
		assert.ok(!/SWA/.test(line), `no SWA anywhere on the HUD or the tab strip: ${line}`);
		assert.ok(!/swarm/i.test(line), `the old role name never reaches a label: ${line}`);
	}
	assert.match(sessionTabs(runs, 0, 200), /1:CODER/);
});
