import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DRAFT_CASES_MAX,
	DRAFT_GOAL_MAX,
	INTAKE_EXPLORE_TOOLS,
	INTAKE_GRACE_CALLS,
	draftCases,
	draftGoal,
	intakeBlockNote,
	intakeDirective,
	intakeDraft,
	intakeGate,
	intakeOpen,
	isExploreTool,
} from "../extensions/finisher/src/intake.ts";

const collapse = (text) => text.replace(/\s+/g, " ").trim();

const PROMPTS = [
	"make the widget faster",
	"- make the widget faster\n- keep the HUD the same\n- prove it with a test",
	"1. confirm the goal first\n2) then explore\n3) then report",
	"แก้บั๊กตอน logout\nเพิ่มหน้า login\nเขียน test ให้ครบ",
	"  \n\t  ",
	"",
	"one line with  double   spaces and\ttabs",
	"\"a quoted goal\"",
	`${"x".repeat(400)}`,
];

test("a drafted goal is always the human's own single line, never invented and never over the cap", () => {
	for (const prompt of PROMPTS) {
		const goal = draftGoal(prompt);
		assert.ok(!goal.includes("\n"), "the goal is one line");
		assert.ok(goal.length <= DRAFT_GOAL_MAX, `the goal stays under ${DRAFT_GOAL_MAX}: ${goal.length}`);
		assert.ok(collapse(prompt).includes(goal), `the goal must come from the prompt, got "${goal}"`);
	}
	assert.equal(draftGoal(""), "");
	assert.equal(draftGoal("   \n\t"), "");
});

test("the goal cap is an exact boundary and truncation never splits a word it can cut at a space", () => {
	const exact = "a".repeat(DRAFT_GOAL_MAX);
	assert.equal(draftGoal(exact), exact);
	assert.equal(draftGoal(`${exact}b`).length, DRAFT_GOAL_MAX);
	const worded = draftGoal(`${"x".repeat(190)} tail here and more words after`);
	assert.ok(worded.length <= DRAFT_GOAL_MAX);
	assert.match(worded, /^x+ tail$/, "the cut lands on a word boundary");
});

test("cases are bounded, distinct, non-empty and always taken from the human's words", () => {
	for (const prompt of PROMPTS) {
		const goal = draftGoal(prompt);
		const cases = draftCases(prompt, goal);
		if (!goal) {
			assert.deepEqual(cases, [], "a blank prompt drafts no case");
			continue;
		}
		assert.ok(cases.length >= 1, "a stated goal always brings at least one case");
		assert.ok(cases.length <= DRAFT_CASES_MAX, `at most ${DRAFT_CASES_MAX} cases, got ${cases.length}`);
		assert.equal(new Set(cases.map((c) => c.toLowerCase())).size, cases.length, "cases are pairwise distinct");
		for (const one of cases) {
			assert.ok(one.length > 0);
			assert.ok(collapse(prompt).includes(one), `case "${one}" must be the human's own text`);
		}
	}
	assert.deepEqual(draftCases(""), []);
	assert.deepEqual(draftCases("\n \n"), []);
});

test("a Thai multi-line message yields exactly the human's own lines, translated by nobody", () => {
	const thai = ["เพิ่มหน้า login", "แก้บั๊กตอน logout", "เขียน test ให้ครบ"].join("\n");
	assert.equal(draftGoal(thai), "เพิ่มหน้า login");
	assert.deepEqual(draftCases(thai), ["แก้บั๊กตอน logout", "เขียน test ให้ครบ"]);
	assert.deepEqual(intakeDraft(thai), { goal: "เพิ่มหน้า login", cases: ["แก้บั๊กตอน logout", "เขียน test ให้ครบ"] });
});

test("the case list is a real bound: nine lines still yield at most the cap", () => {
	const prompt = ["the goal", ...Array.from({ length: 9 }, (_, i) => `case number ${i}`)].join("\n");
	const cases = draftCases(prompt);
	assert.equal(cases.length, DRAFT_CASES_MAX);
	assert.deepEqual(cases, ["case number 0", "case number 1", "case number 2", "case number 3", "case number 4"]);
});

test("the goal-first gate opens exactly below the grace budget and closes at it", () => {
	for (let used = 0; used <= INTAKE_GRACE_CALLS + 4; used++) {
		const gate = intakeGate(undefined, "read", used);
		assert.equal(gate.block, used >= INTAKE_GRACE_CALLS, `blocked at ${used} pre-goal call(s)`);
		assert.equal(gate.remaining, Math.max(0, INTAKE_GRACE_CALLS - used));
		assert.equal(gate.remaining >= 0, true);
	}
	assert.match(intakeGate(undefined, "bash", INTAKE_GRACE_CALLS).reason, /goal/);
	assert.equal(intakeGate(undefined, "read", Number.NaN).block, false, "an unknown count is not a refusal");
	assert.equal(intakeGate(undefined, "read", -5).block, false);
});

test("no gate ever stands between the harness and the goal tools, and no gate survives a confirmed goal", () => {
	for (const tool of ["goal", "lap", "verify", "steer", "web_search", ""])
		for (const used of [0, INTAKE_GRACE_CALLS, 999]) assert.equal(intakeGate(undefined, tool, used).block, false, `${tool} must stay callable`);
	for (const tool of INTAKE_EXPLORE_TOOLS) assert.equal(intakeGate({ goal: "x", confirmedAt: 1 }, tool, 999).block, false);
	for (const tool of ["READ", " Bash "]) assert.equal(isExploreTool(tool), true);
	assert.equal(intakeOpen({ goal: "x" }), false);
	assert.equal(intakeOpen({ goal: "x", confirmedAt: 0 }), false);
	assert.equal(intakeOpen({ goal: "x", confirmedAt: Date.now() }), true);
});

test("the refusal note speaks the human's language, stays one line, and always names goal", () => {
	const thai = intakeBlockNote("th", 0);
	const english = intakeBlockNote("en", 0);
	assert.match(thai, /[\u0E00-\u0E7F]/, "Thai must reach the Thai human");
	assert.doesNotMatch(english, /[\u0E00-\u0E7F]/, "English must not carry Thai");
	assert.match(intakeBlockNote("th-TH", 0), /[\u0E00-\u0E7F]/);
	for (const note of [thai, english, intakeBlockNote(undefined, 3)]) {
		assert.ok(!note.includes("\n") && !note.includes("\t"), "a note is one painted line");
		assert.match(note, /goal/);
	}
});

test("the directive carries every drafted case and points at goal before exploration", () => {
	const thai = ["เพิ่มหน้า login", "แก้บั๊กตอน logout"].join("\n");
	const directive = intakeDirective(thai);
	assert.match(directive, /goal/);
	assert.ok(directive.includes("เพิ่มหน้า login"));
	assert.ok(directive.includes("แก้บั๊กตอน logout"));
	assert.match(intakeDirective(thai, "th"), /[\u0E00-\u0E7F]/);
	const blank = intakeDirective("  ");
	assert.ok(blank.length > 0, "a blank prompt still produces a directive");
	assert.match(blank, /goal/i);
});
