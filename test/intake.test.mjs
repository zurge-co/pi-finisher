import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_CASES_MAX, DRAFT_GOAL_MAX, draftCases, draftGoal, intakeDirective, intakeDraft, intakeOpen } from "../extensions/finisher/src/intake.ts";
import { consultDirective } from "../extensions/finisher/src/consult.ts";

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

test("a confirmed goal is the only thing that closes intake, and the draft never invents one", () => {
	assert.equal(intakeOpen({ goal: "x" }), false);
	assert.equal(intakeOpen({ goal: "x", confirmedAt: 0 }), false);
	assert.equal(intakeOpen({ goal: "x", confirmedAt: Date.now() }), true);
	assert.equal(intakeOpen({ goal: "x", confirmedAt: Number.NaN }), false, "a garbage stamp is not a confirmation");
});

test("the directive carries every drafted case and points at goal, and never a case list on a conversation", () => {
	const thai = ["เพิ่มหน้า login", "แก้บั๊กตอน logout"].join("\n");
	const directive = intakeDirective(thai);
	assert.match(directive, /goal/);
	assert.ok(directive.includes("เพิ่มหน้า login"));
	assert.ok(directive.includes("แก้บั๊กตอน logout"));
	assert.match(intakeDirective(thai, "th"), /[\u0E00-\u0E7F]/);
	const blank = intakeDirective("  ");
	assert.ok(blank.length > 0, "a blank prompt still produces a directive");
	assert.match(blank, /goal/i);
	const prompt = "ทำไมหน้า report ถึงช้า";
	assert.equal(intakeDirective(prompt, "th", "consult"), consultDirective(prompt, "th"), "the consult mode gets the consult directive verbatim");
	assert.ok(!intakeDirective(prompt, "th", "consult").includes("case ="), "no draft case list is pushed in consult mode");
	assert.ok(intakeDirective(prompt, "th", "work").includes("case ="), "a work turn still carries the drafted cases");
	assert.equal(intakeDirective(prompt, undefined, "work"), intakeDirective(prompt), "no intent keeps the goal-first directive unchanged");
});
