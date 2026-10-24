import { test } from "node:test";
import assert from "node:assert/strict";
import {
	acceptanceLines,
	blockedBy,
	contractLines,
	declaredOverlaps,
	findCycles,
	planOrder,
	planRefusalText,
	planRefusals,
	readPlanSlices,
} from "../extensions/finisher/index.ts";

const slice = (id, files, extra = {}) => ({ id, instruction: `do ${id}`, files, ...extra });
const plan = (raw) => readPlanSlices(raw);

test("a slice owns its files: the contract is read from files or the older scope alias, normalised and de-duplicated", () => {
	const [s] = plan([{ id: "a", instruction: "x", files: ["./src//a.ts", "src/a.ts", " src/b/ "] }]);
	assert.deepEqual(s.files, ["src/a.ts", "src/b"], "the same path twice is one path");
	const [legacy] = plan([{ id: "b", instruction: "x", scope: ["lib/"] }]);
	assert.deepEqual(legacy.files, ["lib"], "scope still works, so an older caller is not silently unowned");
	assert.deepEqual(plan([{ id: "c", instruction: "x" }])[0].files, [], "and a slice with no files is visible as unowned");
});

test("a plan with no files, no instruction or a duplicate id is refused before anything is spawned", () => {
	const refusals = planRefusals(plan([{ id: "a", instruction: "x" }, { id: "a", instruction: "y", files: ["src/q.ts"] }, { id: "b", files: ["src/b.ts"] }]));
	const kinds = refusals.map((r) => r.kind).sort();
	assert.deepEqual(kinds, ["files", "id", "instruction"], "every hole in the plan is named");
	assert.equal(planRefusals(plan([{ id: "Bad Id", instruction: "x", files: ["a"] }]))[0].kind, "id", "an unusable id is refused, not sanitised");
	assert.deepEqual(planRefusals(plan([{ id: "a", instruction: "x", files: ["src/a.ts"] }, { id: "b", instruction: "y", files: ["src/b.ts"] }])), [], "a complete plan passes");
});

test("file ownership is exclusive: overlapping declared files are refused, and the refusal names the path", () => {
	const refusals = planRefusals(plan([slice("a", ["src/auth"]), slice("b", ["src/auth/token.ts"])]));
	assert.equal(refusals.length, 1);
	assert.equal(refusals[0].kind, "overlap");
	assert.deepEqual(refusals[0].slices, ["a", "b"]);
	assert.match(refusals[0].detail, /src\/auth/, "the contested path is named so the split can be fixed");
	assert.deepEqual(declaredOverlaps(plan([slice("a", ["src/a.ts"]), slice("b", ["src/b.ts"])])), [], "disjoint paths never collide");
	assert.deepEqual(declaredOverlaps(plan([slice("a", ["src/a.ts"]), slice("b", ["src/a.ts"])]))[0].paths, ["src/a.ts"]);
});

test("depends_on must name a real slice, never itself, and never form a cycle — a cycle can never start", () => {
	assert.equal(planRefusals(plan([slice("a", ["x"], { depends_on: ["ghost"] })]))[0].kind, "dep");
	assert.equal(planRefusals(plan([slice("a", ["x"], { depends_on: ["a"] })]))[0].kind, "dep");
	const cyclic = plan([slice("a", ["x"], { depends_on: ["b"] }), slice("b", ["y"], { depends_on: ["a"] })]);
	assert.equal(planRefusals(cyclic).some((r) => r.kind === "cycle"), true, "a cycle is refused, not scheduled");
	assert.deepEqual(findCycles(cyclic)[0], ["a", "b", "a"], "the cycle is reported as the loop it is");
	assert.deepEqual(findCycles(plan([slice("a", ["x"]), slice("b", ["y"], { depends_on: ["a"] })])), [], "a legal chain is not a cycle");
});

test("the refusal is one readable message that says nothing was started", () => {
	const text = planRefusalText(planRefusals(plan([slice("a", ["src/x"]), slice("b", ["src/x"])])), "0 worktrees");
	assert.match(text, /refused the plan before spawning/);
	assert.match(text, /0 worktrees/);
	assert.match(text, /src\/x/);
	assert.match(text, /Nothing was started/);
});

test("the dependency order is deterministic: ancestors first, id as the tie-break, whatever order the plan lists", () => {
	const base = [slice("c", ["c"], { depends_on: ["a"] }), slice("b", ["b"]), slice("a", ["a"])];
	const { order, depth } = planOrder(plan(base));
	assert.deepEqual(order, ["a", "b", "c"], "a must precede c; b has no dependency so the id breaks the tie");
	assert.equal(depth.a, 0);
	assert.equal(depth.c, 1);
	const shuffled = [slice("b", ["b"]), slice("a", ["a"], { depends_on: ["b"] }), slice("c", ["c"])];
	assert.deepEqual(planOrder(plan(shuffled)).order, ["b", "c", "a"], "the same graph gives the same order from any input order");
	const deep = plan([slice("d", ["d"], { depends_on: ["c"] }), slice("c", ["c"], { depends_on: ["b"] }), slice("b", ["b"], { depends_on: ["a"] }), slice("a", ["a"])]);
	assert.deepEqual(planOrder(deep).order, ["a", "b", "c", "d"], "a chain keeps its chain order");
	assert.deepEqual(planOrder(deep).depth, { a: 0, b: 1, c: 2, d: 3 });
});

test("a failed dependency names its dependents, so the rest of the plan is not attempted blindly", () => {
	const slices = plan([slice("a", ["a"]), slice("b", ["b"], { depends_on: ["a"] }), slice("c", ["c"], { depends_on: ["a", "b"] })]);
	assert.deepEqual(blockedBy(slices, ["a"]), { b: ["a"], c: ["a"] }, "transitively blocked work is not silently attempted");
	assert.deepEqual(blockedBy(slices, ["b"]), { c: ["b"] });
	assert.deepEqual(blockedBy(slices, []), {}, "nothing failed, nothing is blocked");
});

test("the shared contract and the acceptance criteria reach the coder, and are absent when they were not given", () => {
	assert.deepEqual(contractLines(plan([slice("a", ["a"])]), "  "), [], "no contract means no invented one");
	const contract = contractLines(plan([slice("a", ["a"])]), "export type Token = { id: string }");
	assert.match(contract.join("\n"), /SHARED CONTRACT/);
	assert.match(contract.join("\n"), /export type Token/);
	assert.deepEqual(acceptanceLines(plan([slice("a", ["a"])])[0]), [], "a slice with no criteria adds no lines");
	assert.match(acceptanceLines(plan([slice("a", ["a"], { acceptance: ["the token refreshes"] })])[0]).join("\n"), /the token refreshes/);
});
