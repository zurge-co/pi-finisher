import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CLARIFY_AS_IS,
	CLARIFY_GAPS,
	CLARIFY_MAX,
	CLARIFY_OPTIONS_MAX,
	CLARIFY_RULE,
	ambiguousWord,
	applyAnswers,
	clarifyChrome,
	clarifyGaps,
	clarifyNote,
	clarifyOpen,
	clarifyPlan,
	clarifyQuestions,
	decidable,
	markClarify,
} from "../extensions/finisher/index.ts";
import { askClarify } from "../extensions/finisher/index.ts";

const DRAFTS = [
	{ goal: "", cases: [] },
	{ goal: "make it better", cases: [] },
	{ goal: "ปรับปรุงหน่อย", cases: [] },
	{ goal: "speed up the panel widget so it repaints under 16ms", cases: [] },
	{ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] },
	{ goal: "fix the flaky login test in test/login.test.mjs", cases: ["npm test exits 0"] },
	{ goal: "ทำให้ HUD เร็วขึ้น", cases: ["npm test ออกด้วย exit code 0"] },
];

const questionsFor = (gaps, draft, lang = "en") => clarifyQuestions(gaps, draft, lang);

test("the round asks only about understanding: the gaps are one fixed triple, ordered, deduped and bounded", () => {
	assert.deepEqual(CLARIFY_GAPS, ["meaning", "words", "outcome"], "there is no gap for the method and none for the reach");
	assert.equal(CLARIFY_MAX, 3);
	for (const draft of DRAFTS) {
		const gaps = clarifyGaps(draft);
		assert.ok(gaps.length <= CLARIFY_MAX, `at most ${CLARIFY_MAX} gaps, got ${gaps.length}`);
		assert.equal(new Set(gaps).size, gaps.length, "a gap is never asked twice");
		const order = gaps.map((gap) => CLARIFY_GAPS.indexOf(gap));
		assert.deepEqual(order, [...order].sort((a, b) => a - b), "the questions come in one fixed order");
		for (const gap of gaps) assert.ok(CLARIFY_GAPS.includes(gap));
	}
});

test("the outcome gap is exactly the absence of a checkable case, in both directions", () => {
	const goals = ["make it better", "ปรับปรุงหน่อย", "speed up the panel widget", "make the HUD ticker 20% faster in src/hud.ts"];
	const caseSets = [[], ["the goal holds"], ["all good"], ["npm test exits 0"], ["src/hud.ts drops the poll"], ["the goal holds", "`judgeCase` returns fail"]];
	for (const goal of goals) {
		for (const cases of caseSets) {
			const gaps = clarifyGaps({ goal, cases });
			assert.equal(gaps.includes("outcome"), !cases.some(decidable), `goal "${goal}" cases ${JSON.stringify(cases)}`);
		}
	}
	assert.equal(decidable("the goal holds"), false, "a case with no anchor proves nothing");
	assert.equal(decidable("src/hud.ts drops the poll"), true, "a path is an anchor");
	assert.equal(decidable("npm test exits 0"), true, "a real command is an anchor");
	assert.equal(decidable("`judgeCase` returns fail"), true, "a backticked identifier is an anchor");
	assert.equal(decidable("< 16ms repaint"), true, "a bound is an anchor");
});

test("the words gap appears exactly when the goal leans on an ambiguous quality word and gives no number", () => {
	assert.equal(ambiguousWord("make the HUD faster"), "faster");
	assert.equal(ambiguousWord("make the HUD 20% faster"), undefined, "a number settles what the word means");
	assert.equal(ambiguousWord("ทำให้ HUD เร็วขึ้น"), "เร็วขึ้น");
	assert.equal(ambiguousWord("ทำให้ HUD เร็วขึ้น 20%"), undefined);
	assert.equal(ambiguousWord("reduce the repaint to under 16ms"), undefined, "a bound is a number");
	assert.equal(ambiguousWord("rename the tool in src/tools.ts"), undefined, "a goal that names no quality word has nothing to confirm");
	assert.ok(!clarifyGaps({ goal: "make the HUD faster", cases: ["npm test exits 0"] }).includes("words") === false, "the gap follows the word");
	assert.ok(!clarifyGaps({ goal: "make the HUD 20% faster", cases: ["npm test exits 0"] }).includes("words"));
});

test("a checkable case never makes the round longer: gaps only shrink as the draft gets more specific", () => {
	for (const draft of DRAFTS) {
		const before = new Set(clarifyGaps(draft));
		for (const extra of ["npm test exits 0", "src/hud.ts drops the poll", "`judgeCase` returns fail"]) {
			const after = clarifyGaps({ goal: draft.goal, cases: [...draft.cases, extra] });
			for (const gap of after) assert.ok(before.has(gap), `adding "${extra}" to "${draft.goal}" must not open the ${gap} question`);
		}
	}
	assert.deepEqual(clarifyGaps({ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] }), [], "a goal that says what to change and what a number is asks nothing");
});

test("every question offers a pick and the as-is escape last, and never asks how the work is done or how far it reaches", () => {
	const METHOD = /how (?:should|do|to)|which files|where in the code|approach|\bscope\b|อย่างไร|ขอบเขต|วิธีทำ|ไฟล์ไหน/i;
	for (const draft of DRAFTS) {
		const gaps = clarifyGaps(draft);
		for (const lang of ["en", "th"]) {
			const words = clarifyChrome(lang);
			const questions = questionsFor(gaps, draft, lang);
			assert.equal(questions.length, gaps.length, "one question per gap, none invented");
			for (const question of questions) {
				assert.ok(question.options.length >= 2, "a question with one option is not a question");
				assert.ok(question.options.length <= CLARIFY_OPTIONS_MAX, "the picks stay bounded");
				assert.equal(question.options.at(-1), words.asIs, "the escape is always the last option");
				assert.equal(question.options.filter((o) => o === words.asIs).length, 1, "and it appears once");
				assert.equal(new Set(question.options).size, question.options.length, "no option is offered twice");
				assert.doesNotMatch(`${question.question} ${question.options.join(" ")}`, METHOD, `"${question.question}" confirms understanding, not method`);
				assert.ok(question.options.some((option) => option !== words.asIs), "there is always something to pick besides the escape");
			}
		}
	}
	const thai = questionsFor(["meaning"], { goal: "ปรับปรุงหน่อย", cases: [] }, "th");
	const english = questionsFor(["meaning"], { goal: "make it better", cases: [] }, "en");
	assert.match(thai[0].question, /[\u0E00-\u0E7F]/, "the question really is Thai, not a translated label");
	assert.notEqual(thai[0].question, english[0].question, "the question is asked in the human's language");
	assert.equal(CLARIFY_RULE, clarifyChrome("th").note, "the rule the prompt quotes is the human's own");
});

test("the answers are folded into cases the harness can check, and an unusable answer is kept as a note instead of being dropped", () => {
	assert.deepEqual(applyAnswers({ goal: "faster", cases: [] }, {}), { goal: "faster", goalText: "faster", cases: ["faster"], notes: [], open: ["meaning", "words", "outcome"] }, "no answer leaves the draft byte-identical, and still yields one case");
	const asIs = applyAnswers({ goal: "faster", cases: [] }, { meaning: CLARIFY_AS_IS, words: clarifyChrome("th").asIs, outcome: "   " });
	assert.equal(asIs.goal, "faster", "the human's own words stay the goal, so an unchanged goal still resumes");
	assert.deepEqual(asIs.open, ["meaning", "words", "outcome"], "the escape answers nothing");

	const concrete = applyAnswers({ goal: "make it better", cases: [] }, { outcome: "npm test exits 0" });
	assert.deepEqual(concrete.cases, ["npm test exits 0"]);
	assert.equal(decidable(concrete.cases[0]), true, "a case the harness cannot check is never invented");

	const understood = applyAnswers({ goal: "make it better", cases: [] }, { meaning: "the panel stops repainting on every write" });
	assert.deepEqual(understood.cases, ["make it better"], "an unverifiable answer never becomes a case");
	assert.deepEqual(understood.notes, ["what I understand you to mean: the panel stops repainting on every write"]);
	assert.match(understood.goalText, /what I understand you to mean/, "it is kept as a note instead of being dropped");
	assert.equal(understood.goal, "make it better", "and the goal key still does not drift");
	assert.deepEqual(understood.open, ["words", "outcome"]);

	const thai = applyAnswers({ goal: "ปรับปรุงหน่อย", cases: [] }, { words: "เร็วขึ้นแบบชี้เป็นตัวเลขได้", outcome: "npm test exits 0" }, "th");
	assert.match(thai.goalText, /คำที่คุณใช้: เร็วขึ้นแบบชี้เป็นตัวเลขได้/, "the note is labelled in the human's language");
	assert.deepEqual(thai.cases, ["npm test exits 0"]);
	assert.deepEqual(thai.open, ["meaning"]);

	const empty = applyAnswers({ goal: "", cases: [] }, {});
	assert.equal(empty.cases.length, 1, "a goal with nothing in it still cannot produce zero cases");
});

test("a goal is understood exactly once: the same goal never asks again, a changed one does", () => {
	const draft = { goal: "make it better", cases: [] };
	const state = {};
	assert.equal(clarifyOpen(state, "k1"), true, "the first look asks");
	assert.equal(clarifyPlan(draft, state, "k1").ask, true);
	markClarify(state, "k1", 42);
	assert.deepEqual(state.clarify, { goalKey: "k1", at: 42 });
	assert.equal(clarifyOpen(state, "k1"), false, "one round per goal, and only one");
	assert.equal(clarifyPlan(draft, state, "k1").ask, false);
	assert.deepEqual(clarifyPlan(draft, state, "k1").questions, []);
	assert.equal(clarifyOpen(state, "k2"), true, "a different goal is a different question");
	assert.equal(clarifyPlan({ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] }, state, "k3").ask, false, "a goal already understood is never asked about");
});

test("the ask walks the questions in order and stops at the first escape instead of looping", async () => {
	const draft = { goal: "make it better", cases: [] };
	const questions = questionsFor(clarifyGaps(draft), draft, "en");
	const seen = [];
	const answered = await askClarify(async (question) => {
		seen.push(question.gap);
		return question.options[0];
	}, questions);
	assert.deepEqual(seen, questions.map((q) => q.gap), "the order is the caller's, and nothing is asked twice");
	assert.deepEqual(Object.keys(answered.answers), ["meaning", "words", "outcome"]);
	assert.equal(answered.stopped, false);
	assert.equal(answered.asked, questions.length);

	const escaped = await askClarify(async () => null, questions);
	assert.equal(escaped.stopped, true, "an escape stops the round");
	assert.equal(escaped.asked, 1, "and it stops after the first question, not after all of them");
	assert.deepEqual(escaped.answers, {}, "nothing is invented from an escape");

	const asIs = await askClarify(async (question) => question.options.at(-1), questions);
	assert.deepEqual(asIs.answers, {}, "picking the escape is not an answer");
	assert.equal(asIs.stopped, false, "but it is a choice, not a stall");
	assert.equal(asIs.asked, questions.length);
});

test("the note speaks the human's language and counts what is left instead of listing questions already answered", () => {
	assert.match(clarifyNote(["outcome", "meaning"], "en"), /2 point\(s\)/, "the note keeps the count of what is still open");
	assert.match(clarifyNote(["outcome", "meaning"], "th"), /[\u0E00-\u0E7F]/);
	assert.equal(clarifyNote([], "en"), "nothing to ask: I already read this goal the way you meant it");
	assert.equal(clarifyNote([], "th"), "ไม่ต้องถามเพิ่ม: ฉันเข้าใจ goal นี้ตรงกับที่คุณหมายไว้แล้ว");
});
