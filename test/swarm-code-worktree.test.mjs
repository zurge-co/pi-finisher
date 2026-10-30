import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodeWorkerPrompt, planSlices, scopesOverlap } from "../extensions/finisher/index.ts";

const slice = (id, scope, instruction = "do it") => ({ id, instruction, ...(scope ? { scope } : {}) });

const permutations = (xs) => {
	if (xs.length <= 1) return [xs];
	const out = [];
	for (let i = 0; i < xs.length; i++) for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([xs[i], ...rest]);
	return out;
};

const nest = (a, b) => {
	const x = a.replace(/\/+$/, "");
	const y = b.replace(/\/+$/, "");
	return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

test("a slice gets exactly one worktree and one branch, and no two slices share either", () => {
	const slices = [slice("s1"), slice("s2"), slice("s3"), slice("s4")];
	const plans = permutations(slices).map((order) => planSlices(order, "/tmp/run", "r1"));
	for (const plans1 of plans) {
		assert.equal(new Set(plans1.map((p) => p.worktreeDir)).size, plans1.length);
		assert.equal(new Set(plans1.map((p) => p.branch)).size, plans1.length);
		assert.ok(plans1.every((p) => p.branch.startsWith("finisher/swarm/r1/")));
		assert.ok(plans1.every((p) => p.worktreeDir.endsWith(`/${p.id}`)));
	}
});

test("the worker is told to stay in its slice and to report the paths it touched", () => {
	const p = buildCodeWorkerPrompt(slice("s1", ["./src/"]), { goal: "ship it", worktreeDir: "/tmp/run/s1", scopes: ["src"] });
	assert.match(p, /own checkout: \/tmp\/run\/s1/);
	assert.match(p, /Stay inside your slice's paths: src/);
	assert.match(p, /FILES: <comma-separated/);
	assert.match(p, /no comments in code/);
	assert.doesNotMatch(p, /another slice's files\.\n\nYour slice/);
});

test("the worker prompt names the real run deadline in seconds and demands commands that fit inside it", () => {
	const p = buildCodeWorkerPrompt(slice("s1", ["./src/"]), { worktreeDir: "/tmp/run/s1", scopes: ["src"], deadlineMs: 600_000 });
	assert.match(p, /killed without warning 600 seconds after you start/, "the exact seconds, not a vague hurry-up");
	assert.match(p, /split long builds and full test runs into smaller pieces/, "and the instruction that keeps one command from outliving it");
	for (const bad of [undefined, 0, -5, Number.NaN]) {
		const q = buildCodeWorkerPrompt(slice("s1", ["./src/"]), { worktreeDir: "/tmp/run/s1", scopes: ["src"], ...(bad === undefined ? {} : { deadlineMs: bad }) });
		assert.doesNotMatch(q, /killed without warning/, `deadlineMs=${bad} must never print a deadline line`);
	}
	const odd = buildCodeWorkerPrompt(slice("s1", ["./src/"]), { worktreeDir: "/tmp/run/s1", scopes: ["src"], deadlineMs: 1 });
	assert.match(odd, /killed without warning 1 seconds after you start/, "a sub-second bound still rounds to a real, nonzero deadline");
});

test("scope containment is reflexive, nesting-aware and symmetric", () => {
	assert.equal(scopesOverlap("src", "src"), true);
	assert.equal(scopesOverlap("src", "src/a.ts"), true);
	assert.equal(scopesOverlap("src/a.ts", "src"), true);
	assert.equal(scopesOverlap("./src/", "src/b"), true);
	assert.equal(scopesOverlap("src", "test"), false);
	assert.equal(scopesOverlap("src/a", "src/ab"), false);
	assert.equal(scopesOverlap("", "src"), true);
	const pairs = [["src", "lib"], ["src/a", "src/b"], ["docs", "docs/api"]];
	for (const [a, b] of pairs) assert.equal(scopesOverlap(a, b), scopesOverlap(b, a), `${a}/${b} must be symmetric like a real overlap`);
	for (const [a, b] of pairs) assert.equal(scopesOverlap(a, b), nest(a, b), "overlap must agree with path nesting");
});
