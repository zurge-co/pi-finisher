import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, elapsedLabel, formatPanelRow, liveRuns, panelLines, panelRows, panelTickMs, streamTail } from "../extensions/zense-harness/index.ts";

const run = (role, extra = {}) => ({ role, status: "running", startedAt: 1_000, at: 1_000, ...extra });

test("every running agent gets its own row at the same time — none is hidden behind a picker", () => {
	const runs = [run("swarm", { model: "m/one", slotId: "s1" }), run("swarm", { model: "m/two", slotId: "s2" }), run("grader")];
	const rows = panelRows(runs, { now: 3_000 });
	assert.equal(rows.length, 3);
	assert.deepEqual(rows.map((r) => r.slot).filter(Boolean), ["s1", "s2"]);
	assert.deepEqual(rows.map((r) => r.model).filter(Boolean), ["m/one", "m/two"]);
	assert.ok(rows.every((r) => r.state === "▶"));
	assert.equal(panelLines(runs, { now: 3_000 })[0], "AGENTS ▸ 3 running");
});

test("identical role and model still produce distinguishable row tags", () => {
	const rows = panelRows([run("swarm", { model: "m/one" }), run("swarm", { model: "m/one" }), run("swarm", { model: "m/one" })]);
	assert.deepEqual(rows.map((r) => r.tag), ["SWA", "SWA2", "SWA3"]);
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
	const row = formatPanelRow({ tag: "SWA", role: "swarm", state: "▶", slot: "s1", model: "provider/a-long-model-name", elapsed: "12s", tail: "x".repeat(200) }, 60, 80);
	assert.ok(row.length <= 60, `row is ${row.length} chars`);
	assert.match(row, /^SWA +▶ swarm/);
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
