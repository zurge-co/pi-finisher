import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSpecChanges, groupSpecChanges, renderSpecChangesTui, renderSignOutcome, renderSpecMd, renderTrackerOutcomes, goalLines, sameGoalLines, decideSpecApproval, rejectionDirective } from "../extensions/zense-harness/index.ts";

const baseSpec = (over = {}) => ({
	version: 1,
	title: "Fix login redirect",
	intent: "users hit /login twice",
	approach: ["read auth code", "patch guard"],
	scope: ["src/auth"],
	constraints: ["no new deps"],
	criteria: [
		{ id: "c1", text: "login test passes", check: "npm test" },
		{ id: "c2", text: "guard exists", check: "path exists: src/auth/guard.ts" },
	],
	specDebt: ["verify UX by eye"],
	approved: false,
	...over,
});

test("buildSpecChanges: identical spec → a single warning line (never re-present silently)", () => {
	const prev = baseSpec({ version: 3 });
	const next = baseSpec({ version: 4 });
	const lines = buildSpecChanges(prev, next);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /No changes from v3/);
	assert.ok(lines[0].startsWith("⚠️"));
});

test("buildSpecChanges: title / intent changes", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({ version: 2, title: "New title", intent: "different intent" });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.includes('title: "Fix login redirect" → "New title"')));
	assert.ok(lines.some((l) => l.startsWith("intent:")));
});

test("buildSpecChanges: criteria added / removed / changed (text and check)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		criteria: [
			{ id: "c1", text: "login test passes", check: "npm test" },
			{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" },
			{ id: "c3", text: "session persists", check: "npx vitest run" },
		],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.some((l) => l.startsWith("criteria +: c3: session persists")));
	assert.ok(!lines.some((l) => l.includes("c1"))); 	const c2 = lines.find((l) => l.startsWith("criteria ~: c2"));
	assert.ok(c2, "expected a criteria ~: c2 line");
	assert.ok(c2.includes('text: "guard exists" → "guard renders"'));
	assert.ok(c2.includes('check: "path exists: src/auth/guard.ts" → "path exists: src/auth/guard.tsx"'));

		const removed = buildSpecChanges(next, prev).find((l) => l.startsWith("criteria −:"));
	assert.equal(removed, "criteria −: c3: session persists");
});

test("buildSpecChanges: scope / constraints / approach / specDebt list diffs (+/−)", () => {
	const prev = baseSpec({ version: 1 });
	const next = baseSpec({
		version: 2,
		approach: ["read auth code", "patch guard", "add regression test"],
		scope: ["src/auth", "src/session"],
		constraints: [],
		specDebt: [],
	});
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: add regression test"));
	assert.ok(lines.includes("scope +: src/session"));
	assert.ok(lines.includes("constraints −: no new deps"));
	assert.ok(lines.includes("specDebt −: verify UX by eye"));
});

test("buildSpecChanges: tolerates missing optional field (old persisted spec has no approach)", () => {
	const prev = baseSpec({ version: 1 });
	delete prev.approach; 	const next = baseSpec({ version: 2 });
	const lines = buildSpecChanges(prev, next);
	assert.ok(lines.includes("approach +: read auth code"));
	assert.ok(!lines.some((l) => l.startsWith("approach −:")));
});

test("renderSpecMd: Changes section only when the spec has changesFrom — v2 shows it, older specs render as before without crashing", () => {
	const changes = ["scope +: src/session", "⚠️ No changes from v9"];
	const withChanges = baseSpec({ version: 10, changesFrom: changes });
	const md = renderSpecMd(withChanges);
	assert.ok(md.includes("## Changes in v10 (vs v9)"));
		assert.ok(md.includes("### Scope\n1. scope +: src/session"));
	assert.ok(!md.includes("- scope +: src/session"));
		assert.ok(md.includes("⚠️ No changes from v9"));
		assert.ok(md.indexOf("## Changes in v10") < md.indexOf("## Intent"));

		const old = baseSpec({ version: 10 });
	assert.ok(!renderSpecMd(old).includes("## Changes"));
	const empty = baseSpec({ version: 10, changesFrom: [] });
	assert.ok(!renderSpecMd(empty).includes("## Changes"));
});

test("groupSpecChanges: fixed group order + numbering restarts at 1 per group + +/−/~ markers kept", () => {
	const lines = buildSpecChanges(
		baseSpec({ version: 1 }),
		baseSpec({
			version: 2,
			title: "New title",
			intent: "new intent",
			approach: ["read auth code", "patch guard", "add regression test"],
			scope: ["src/auth", "src/session"],
			constraints: [],
			criteria: [
				{ id: "c1", text: "login test passes", check: "npm test" },
				{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" },
				{ id: "c3", text: "session persists", check: "npx vitest run" },
			],
			specDebt: [],
		}),
	);
	const md = groupSpecChanges(lines);
		const order = ["### Title & intent", "### Approach", "### Scope", "### Constraints", "### Criteria", "### Spec debt"]
		.filter((h) => md.includes(h))
		.map((h) => md.indexOf(h));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
		assert.ok(md.includes("### Approach\n1. approach +: add regression test"));
	assert.ok(md.includes("1. scope +: src/session"));
	assert.ok(md.includes("1. constraints −: no new deps"));
	assert.ok(md.includes("1. specDebt −: verify UX by eye"));
	assert.ok(md.includes("1. criteria ~: c2"));
	assert.ok(md.includes("2. criteria +: c3: session persists (check: npx vitest run)"));
		assert.ok(md.includes('### Title & intent\n1. title: "Fix login redirect" → "New title"\n2. intent:'));
});

test("groupSpecChanges: ⚠️ identical line renders verbatim without a heading", () => {
	const md = groupSpecChanges(["⚠️ No changes from v3 — the new spec is identical to the previous version"]);
	assert.equal(md, "⚠️ No changes from v3 — the new spec is identical to the previous version");
});

test("groupSpecChanges: ungroupable lines land last in ### Other (never drop a change)", () => {
	const md = groupSpecChanges(["approach +: x", "unrecognized line"]);
	assert.ok(md.indexOf("### Approach") < md.indexOf("### Other"));
	assert.ok(md.includes("### Other\n1. unrecognized line"));
});

const tag = (role, t) => `<${role}>${t}</>`;
test("renderSpecChangesTui: drops redundant heading labels + colors by marker (+ → success / − → error / ~ → warning)", () => {
	const lines = buildSpecChanges(
		baseSpec({ version: 1 }),
		baseSpec({
			version: 2,
			title: "New title",
			intent: "new intent",
			approach: ["read auth code", "patch guard", "add regression test"],
			scope: ["src/auth", "src/session"],
			constraints: [],
			criteria: [
				{ id: "c1", text: "login test passes", check: "npm test" },
				{ id: "c2", text: "guard renders", check: "path exists: src/auth/guard.tsx" },
				{ id: "c3", text: "session persists", check: "npx vitest run" },
			],
			specDebt: [],
		}),
	);
	const out = renderSpecChangesTui(baseSpec({ version: 2, changesFrom: lines }), tag);
	const md = out.join("\n");
		assert.equal(out[0], "## Changes in v2 (vs v1)");
	const order = ["### Title & intent", "### Approach", "### Scope", "### Constraints", "### Criteria", "### Spec debt"]
		.filter((h) => md.includes(h))
		.map((h) => md.indexOf(h));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
		assert.ok(md.includes("### Approach\n<success>1. add regression test</>"));
	assert.ok(md.includes("### Scope\n<success>1. src/session</>"));
	assert.ok(md.includes("### Constraints\n<error>1. no new deps</>"));
	assert.ok(md.includes("### Spec debt\n<error>1. verify UX by eye</>"));
	assert.ok(!/(^|\n)\d+\. [+−~]/.test(md), "no marker may remain after the list number");
	assert.ok(!md.includes("approach +") && !md.includes("scope +"), "no redundant heading labels may remain");
		const c2 = out.find((l) => l.startsWith("<warning>"));
	assert.ok(c2, "expected a warning-colored criteria ~ item");
	assert.ok(c2.includes('1. c2 text: "guard exists" → "guard renders"'));
	assert.ok(md.includes("<success>2. c3: session persists (check: npx vitest run)</>"));
		assert.ok(out.includes('1. title: "Fix login redirect" → "New title"'));
	assert.ok(out.some((l) => l.startsWith("2. intent:")));
});

test("renderSpecChangesTui: ⚠️ identical is neutral verbatim without a heading; no changesFrom → []", () => {
	const warn = "⚠️ No changes from v3 — the new spec is identical to the previous version";
	const out = renderSpecChangesTui(baseSpec({ version: 4, changesFrom: [warn] }), tag);
	assert.deepEqual(out, ["## Changes in v4 (vs v3)", "", warn]);
	assert.deepEqual(renderSpecChangesTui(baseSpec({ version: 4 }), tag), []);
	assert.deepEqual(renderSpecChangesTui(baseSpec({ version: 4, changesFrom: [] }), tag), []);
});

test("renderSpecChangesTui: Other lines are neutral and land last, like the archive", () => {
	const out = renderSpecChangesTui(baseSpec({ version: 2, changesFrom: ["scope +: x", "unrecognized line"] }), tag);
	const md = out.join("\n");
	assert.ok(md.indexOf("### Scope\n<success>1. x</>") < md.indexOf("### Other\n1. unrecognized line"));
});

test("goalLines: crossCheck wins over legacy outcomes over intent; blanks dropped, intent capped", () => {
	assert.deepEqual(goalLines({ crossCheck: [" A happens when B ", "  "], outcomes: "legacy", intent: "why" }), ["A happens when B"]);
	assert.deepEqual(goalLines({ outcomes: "one\ntwo", intent: "why" }), ["one", "two"]);
	assert.deepEqual(goalLines({ intent: "why\nthis" }), ["why", "this"]);
	assert.deepEqual(goalLines({}), []);
});

test("sameGoalLines: whitespace/punctuation/order-insensitive; two empty lists are never 'unchanged'", () => {
	assert.equal(sameGoalLines({ crossCheck: ["A when B", "C goes away"] }, { crossCheck: ["c goes away.", "  a   when b "] }), true);
	assert.equal(sameGoalLines({ outcomes: "A when B" }, { crossCheck: ["a when b!"] }), true, "legacy outcomes fingerprint against new crossCheck");
	assert.equal(sameGoalLines({ crossCheck: ["A"] }, { crossCheck: ["B"] }), false);
	assert.equal(sameGoalLines({}, {}), false, "nothing to compare must ask for a signature");
	assert.equal(sameGoalLines({ intent: "" }, { crossCheck: [] }), false);
});

test("decideSpecApproval: tracker > gate-off > goals-unchanged > ask; no UI stays unsigned", () => {
	assert.deepEqual(decideSpecApproval({ signMode: "auto", gateEnabled: true, goalsUnchanged: false, hasUI: true, tui: true }), { kind: "auto", reason: "tracker" });
	assert.deepEqual(decideSpecApproval({ gateEnabled: false, goalsUnchanged: false, hasUI: false, tui: false }), { kind: "auto", reason: "gate-off" });
	assert.deepEqual(decideSpecApproval({ gateEnabled: true, goalsUnchanged: true, hasUI: true, tui: true }), { kind: "auto", reason: "goals-unchanged" });
	assert.deepEqual(decideSpecApproval({ gateEnabled: true, goalsUnchanged: false, hasUI: true, tui: true }), { kind: "ask", mode: "tui" });
	assert.deepEqual(decideSpecApproval({ gateEnabled: true, goalsUnchanged: false, hasUI: true, tui: false }), { kind: "ask", mode: "select" });
	assert.deepEqual(decideSpecApproval({ gateEnabled: true, goalsUnchanged: false, hasUI: false, tui: false }), { kind: "unsigned", reason: "no-ui" });
});

test("rejectionDirective: every dialog's reason reaches the agent with a concrete next step", () => {
	assert.match(rejectionDirective("spec", "B should mean something else", 3), /did NOT sign spec v3/);
	assert.match(rejectionDirective("spec", "B should mean something else", 3), /call zense_spec again/);
	assert.match(rejectionDirective("tracker", "split phase 2"), /call zense_longrun plan again/);
	assert.match(rejectionDirective("review", "missing the empty state"), /staged change was left untouched/);
	assert.match(rejectionDirective("gate", "fix the goal first"), /write is blocked/);
	assert.match(rejectionDirective("spec", "  "), /\(no reason given\)/);
});

test("renderSignOutcome: cross-check cases + .zense/spec.md pointer; technical sections can never leak", () => {
	const md = renderSignOutcome(baseSpec({ crossCheck: ["คุณต้องการให้ A มี B เกิดขึ้นเมื่อ C", "เมื่อ 1 แล้ว 2 จะหายไป"] }));
	assert.match(md, /## Cross-check — what we understood you want/);
	assert.match(md, /- คุณต้องการให้ A มี B เกิดขึ้นเมื่อ C/);
	assert.match(md, /- เมื่อ 1 แล้ว 2 จะหายไป/);
	assert.match(md, /\.zense\/spec\.md/, "the pointer must name the technical spec file");
		assert.ok(!md.includes("src/auth"), "scope prefixes must not appear in the sign body");
	assert.ok(!md.includes("npm test") && !md.includes("path exists:"), "raw checks must not appear");
	assert.ok(!md.includes("verify UX by eye"), "spec debt must not appear");
	assert.ok(!md.includes("Approach") && !md.includes("read auth code"), "approach steps must not appear");
});

test("renderSignOutcome: legacy spec without crossCheck falls back to outcomes lines then intent (no crash)", () => {
	const legacy = renderSignOutcome(baseSpec({ outcomes: "one login, no repeat" }));
	assert.match(legacy, /- one login, no repeat/);
	const bare = renderSignOutcome(baseSpec());
	assert.match(bare, /- users hit \/login twice/);
	assert.ok(!bare.includes("src/auth"), "the fallback must still never leak technical sections");
});

test("renderSpecMd: Cross-check + legacy 'What you'll get' sections present only when their fields exist", () => {
	assert.match(renderSpecMd(baseSpec({ crossCheck: ["A when B"] })), /## Cross-check \(what we understood you want\)/);
	assert.match(renderSpecMd(baseSpec({ outcomes: "one login, no repeat" })), /## What you'll get/);
	assert.ok(!renderSpecMd(baseSpec()).includes("Cross-check"), "no crossCheck → no heading, legacy render unchanged");
	assert.match(renderSpecMd(baseSpec({ crossCheck: ["x"] })), /## Acceptance criteria/, "archive keeps the technical sections");
});

const baseTracker = (over = {}) => ({
	version: 1,
	slug: "migrate-auth",
	title: "Migrate auth",
	intent: "Move auth to oauth\nline two",
	worktreeBranch: "zense/longrun/migrate-auth",
	status: "planning",
	updatedAt: Date.now(),
	phases: [
		{ id: "p1", title: "store", intent: "token store", crossCheck: ["คุณจะล็อกอินครั้งเดียวแล้วคงอยู่ต่อได้"], scope: ["src/store"], constraints: [], criteria: [{ id: "S1", text: "t", check: "npm test" }], status: "pending" },
		{ id: "p2", title: "login flow", intent: "oauth login first line", scope: ["src/login"], constraints: [], criteria: [{ id: "S2", text: "t2", check: "true" }], status: "pending" },
	],
	...over,
});

test("renderTrackerOutcomes: set + per-phase cross-check groups + tracker.md pointer; never scope/checks", () => {
	const md = renderTrackerOutcomes(baseTracker({ crossCheck: ["คุณต้องการให้ระบบล็อกอินทำงานครั้งเดียว", "เมื่อกลับมาอีกครั้งไม่ต้องกรอกซ้ำ"], outcomes: "legacy summary" }));
	assert.match(md, /## Cross-check — what we understood you want/);
	assert.match(md, /- คุณต้องการให้ระบบล็อกอินทำงานครั้งเดียว/);
	assert.match(md, /- \*\*p1 “store”\*\*/);
	assert.match(md, /  - คุณจะล็อกอินครั้งเดียวแล้วคงอยู่ต่อได้/, "p1 crossCheck line");
	assert.match(md, /- \*\*p2 “login flow”\*\*/);
	assert.match(md, /  - oauth login first line/, "a phase without crossCheck falls back to its intent first line");
	assert.match(md, /\.zense\/long-running\/migrate-auth\/tracker\.md/, "pointer names the tracker file");
	assert.ok(!md.includes("src/store") && !md.includes("src/login"), "scope paths must not leak");
	assert.ok(!md.includes("npm test") && !md.includes("S1"), "criteria ids/checks must not leak");
});

test("renderTrackerOutcomes: no tracker-level crossCheck/outcomes → requirement intent leads (fallback, never a crash)", () => {
	const md = renderTrackerOutcomes(baseTracker());
	assert.match(md, /- Move auth to oauth/);
});
