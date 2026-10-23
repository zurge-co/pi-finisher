import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeSliceId, normalizeScope, parseWorkerFiles, planSlice, planSlices } from "../extensions/finisher/index.ts";

const slice = (id, scope) => ({ id, instruction: "do it", ...(scope ? { scope } : {}) });
const unsafe = ["", "../escape", "a/b", "a\\b", "A", "with space", "dots..dir", "-lead", "x".repeat(33), "id\u0000null", "..", "./rel"];

test("no unsafe slice id can ever reach a worktree path", () => {
	for (const id of unsafe) {
		assert.equal(isSafeSliceId(id), false, `"${id}" must be rejected`);
		assert.throws(() => planSlice(slice(id), "/tmp/run", "r1"), /unsafe slice id/, `"${id}" must not plan`);
	}
	for (const id of ["a", "p2", "slice_1", "s-1", "0", "x".repeat(32)]) assert.equal(isSafeSliceId(id), true, `"${id}" is fine`);
});

test("every planned worktree stays inside the run root, whatever the slice id", () => {
	const plans = planSlices(["a", "b", "c"].map((id) => slice(id)), "/tmp/run", "r1");
	for (const p of plans) {
		assert.ok(p.worktreeDir.startsWith("/tmp/run/"), `${p.worktreeDir} escaped the run root`);
		assert.equal(p.worktreeDir.slice("/tmp/run/".length).includes("/"), false, "a slice must not nest its worktree");
	}
});

test("duplicate ids and branch collisions never produce two workers on one checkout", () => {
	assert.throws(() => planSlices([slice("a"), slice("a")], "/tmp/run", "r1"), /duplicate slice id/);
	const reused = planSlice(slice("a"), "/tmp/run", "r1", ["finisher/swarm/r1/a"]);
	assert.notEqual(reused.branch, "finisher/swarm/r1/a");
	const plans = planSlices([slice("b"), slice("a")], "/tmp/run", "r1");
	assert.deepEqual(new Set(plans.map((p) => p.worktreeDir)).size, 2);
	assert.deepEqual(new Set(plans.map((p) => p.branch)).size, 2);
});

test("worker-reported paths are repo-relative and cannot climb out of the repo", () => {
	assert.deepEqual(parseWorkerFiles("work done\nFILES: src/a.ts, src/b.ts"), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(parseWorkerFiles("FILES: /etc/passwd ../outside src/../ok.ts"), [], "absolute and climbing paths are dropped, never rewritten");
	assert.deepEqual(parseWorkerFiles("FILES: src/a.ts ../../etc/passwd"), ["src/a.ts"]);
	assert.deepEqual(parseWorkerFiles("no marker here"), []);
	assert.deepEqual(parseWorkerFiles("FILES: src/a.ts\nmore talk"), ["src/a.ts"], "the marker line is what counts, whatever follows it");
	assert.equal(normalizeScope("./src//a.ts/"), "src//a.ts");
});
