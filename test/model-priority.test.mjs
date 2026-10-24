import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampConcurrency,
	ladderPatterns,
	orderSlots,
	pickSlot,
	readModelLadder,
	readSwarmConcurrency,
	swarmSlots,
} from "../extensions/finisher/index.ts";

const repo = (models, config) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-ladder-"));
	mkdirSync(join(dir, ".finisher"), { recursive: true });
	if (models !== undefined) writeFileSync(join(dir, ".finisher", "models.json"), JSON.stringify(models));
	if (config !== undefined) writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify(config));
	return dir;
};

const permutations = (xs) => {
	if (xs.length <= 1) return [xs];
	const out = [];
	for (let i = 0; i < xs.length; i++) for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([xs[i], ...rest]);
	return out;
};

const slot = (id, priority) => ({ id, priority });

test("priority order is a total order for every permutation of the ladder", () => {
	const base = [slot("a", 3), slot("b", 1), slot("c", 5), slot("d", 2), slot("e", 4)];
	const sorted = permutations(base).map((p) => orderSlots(p).map((s) => s.priority));
	assert.ok(sorted.every((p) => p.every((v, i) => i === 0 || p[i - 1] <= v)), "sorted priorities must be non-decreasing");
	assert.ok(sorted.every((p) => [...p].sort((x, y) => x - y).join() === p.join()), "sorting must not lose or duplicate a slot");
	assert.deepEqual(orderSlots(base).map((s) => s.id), ["b", "d", "a", "e", "c"]);
});

test("the ladder walk exhausts untried slots before wrapping, never inventing a slot", () => {
	const slots = [slot("s1", 1), slot("s2", 2), slot("s3", 3)];
	const seen = [];
	let tried = [];
	for (let i = 0; i < 7; i++) {
		const chosen = pickSlot(slots, tried);
		seen.push(chosen.id);
		tried = [...tried, chosen.id];
		if (tried.length === slots.length) tried = [];
	}
	assert.deepEqual(seen, ["s1", "s2", "s3", "s1", "s2", "s3", "s1"]);
	assert.equal(pickSlot([], []), undefined);
});

test("concurrency is the meet of request, slots, tasks and the hard ceiling", () => {
	assert.equal(clampConcurrency(5, 5, 5), 5);
	assert.equal(clampConcurrency(50, 5, 50), 5);
	assert.equal(clampConcurrency(5, 5, 2), 2);
	assert.equal(clampConcurrency(0.9, 5, 5), 1);
	assert.equal(clampConcurrency(Number.NaN, 3, 9), 3);
	assert.equal(clampConcurrency(3, 0, 9), 0);
	assert.equal(clampConcurrency(3, 3, 0), 0);
	assert.equal(clampConcurrency(1e9, 40, 40), 16);
});

test("only set slots are used once, in priority order, and config supplies them", () => {
	assert.deepEqual(ladderPatterns({ priority1: "a", priority5: "b", priority3: "a", priority2: "  " }), ["a", "b"]);
	assert.deepEqual(swarmSlots(["a", "", "b"]).map((s) => [s.model, s.priority]), [["a", 1], ["b", 2]]);
	const dir = repo({ priority2: "m/two", priority1: "m/one" }, { swarmConcurrency: 2 });
	assert.deepEqual(readModelLadder(dir), ["m/one", "m/two"]);
	assert.equal(readSwarmConcurrency(dir), 2);
	assert.deepEqual(readModelLadder(repo(undefined, undefined)), []);
	assert.equal(readSwarmConcurrency(repo({}, {}), 4), 4);
});
