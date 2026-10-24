import { test } from "node:test";
import assert from "node:assert/strict";
import { findOverlaps, mergeOrder, mergeReport, mergeSignature, planMerge, sliceViolations } from "../extensions/finisher/index.ts";

const out = (id, paths, ok = true) => ({ id, ok, paths });

const permutations = (xs) => {
	if (xs.length <= 1) return [xs];
	const result = [];
	for (let i = 0; i < xs.length; i++) for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) result.push([xs[i], ...rest]);
	return result;
};

test("merge order depends only on slice ids, never on the order workers finished", () => {
	const outcomes = [out("c", ["c.ts"]), out("a", ["a.ts"]), out("b", ["b.ts"]), out("d", ["d.ts"])];
	const signatures = permutations(outcomes).map((p) => mergeSignature(planMerge(p)));
	assert.equal(new Set(signatures).size, 1, "the same work must always produce the same merge plan");
	assert.deepEqual(mergeOrder(outcomes).map((o) => o.id), ["a", "b", "c", "d"]);
	assert.deepEqual(planMerge(outcomes).order, ["a", "b", "c", "d"]);
});

test("a failed or empty worker contributes nothing to the merge", () => {
	const plan = planMerge([out("a", ["a.ts"]), out("b", ["b.ts"], false), out("c", [])]);
	assert.deepEqual(plan.order, ["a", "c"]);
	assert.equal(planSignatureCount(plan), 2);
});

const planSignatureCount = (plan) => plan.steps.length;

test("two workers touching any shared path are blocked, and the pair is reported", () => {
	const outcomes = [out("a", ["src/x.ts", "src/shared.ts"]), out("b", ["src/y.ts", "src/shared.ts"]), out("c", ["src/z.ts"])];
	const plan = planMerge(outcomes);
	assert.deepEqual(plan.overlaps.map((o) => [o.a, o.b, o.paths]), [["a", "b", ["src/shared.ts"]]]);
	assert.deepEqual(plan.blocked, ["a", "b"]);
	assert.deepEqual(plan.steps.find((s) => s.id === "c").apply, true);
	assert.match(mergeReport(plan, outcomes), /a ↔ b: src\/shared\.ts/);
	assert.match(mergeReport(plan, outcomes), /never merged silently/);
});

test("overlap detection is order-independent and reports every contested pair once", () => {
	const outcomes = [out("a", ["p"]), out("b", ["p"]), out("c", ["p"]), out("d", ["q"]), out("e", ["q"])];
	const rounds = permutations([outcomes[2], outcomes[0], outcomes[4], outcomes[1], outcomes[3]]).map((p) => JSON.stringify(findOverlaps(p)));
	assert.equal(new Set(rounds).size, 1);
	const pairs = findOverlaps(outcomes).map((o) => `${o.a}${o.b}`);
	assert.deepEqual(pairs, ["ab", "ac", "bc", "de"]);
	assert.equal(findOverlaps([out("a", ["p"]), out("b", ["q"])]).length, 0);
});

test("the same path reported twice by one worker is not a self-conflict", () => {
	assert.equal(findOverlaps([out("a", ["p", "p", "./p"])]).length, 0);
	const plan = planMerge([out("a", ["p", "p"])]);
	assert.deepEqual(plan.blocked, []);
});

test("an explicit override merges everything but still reports the overlaps", () => {
	const outcomes = [out("a", ["p"]), out("b", ["p"])];
	const plan = planMerge(outcomes, { allowOverlap: true });
	assert.deepEqual(plan.blocked, []);
	assert.equal(plan.overlaps.length, 1);
});

test("a coder's own files are held to the same code rules before anything merges", () => {
	const files = { "src/clean.ts": "export const a = 1;\n", "src/dirty.ts": "export const a = 1;\n// just a note\n", "README.md": "// fine here\n" };
	const violations = sliceViolations(Object.keys(files), (p) => files[p]);
	assert.deepEqual(violations.map((v) => [v.path, v.kind]), [["src/dirty.ts", "comment"]]);
	assert.deepEqual(sliceViolations(["missing.ts"], () => undefined), []);
	const big = "src/huge.ts";
	assert.equal(sliceViolations([big], () => Array.from({ length: 501 }, () => "x").join("\n"))[0].kind, "length");
});

test("the merge order is topological: a dependency is applied before the slice that builds on it, id breaking ties", () => {
	const dependent = (id, paths, deps) => ({ ...out(id, paths), dependsOn: deps });
	const outcomes = [dependent("c", ["c.ts"], ["b"]), dependent("a", ["a.ts"], []), dependent("b", ["b.ts"], ["a"]), dependent("d", ["d.ts"], [])];
	assert.deepEqual(mergeOrder(outcomes).map((o) => o.id), ["a", "d", "b", "c"], "a before b before c; d is free, so the id breaks the tie at depth 0");
	const shuffled = [outcomes[3], outcomes[2], outcomes[1], outcomes[0]];
	assert.deepEqual(mergeOrder(shuffled).map((o) => o.id), ["a", "d", "b", "c"], "the order is a property of the graph, not of who finished first");
	assert.deepEqual(mergeOrder([dependent("x", ["x.ts"], ["ghost"]), out("y", ["y.ts"])]).map((o) => o.id), ["x", "y"], "an unknown dependency cannot reorder anything");
});

test("a dependency that failed does not drag its dependents into the merge", () => {
	const dependent = (id, ok, deps) => ({ ...out(id, [`${id}.ts`], ok), dependsOn: deps });
	const plan = planMerge([dependent("a", false, []), dependent("b", true, ["a"]), dependent("c", true, [])]);
	assert.deepEqual(plan.order, ["c", "b"], "only the slices that produced work are ordered, and the dependent still follows its depth even when its ancestor failed");
	assert.equal(plan.steps.every((s) => s.apply), true);
});
