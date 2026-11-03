import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CLARIFY_AS_IS,
	CLARIFY_CHROME_KEYS,
	CLARIFY_MAX,
	CLARIFY_OPTIONS_MAX,
	CLARIFY_RULE,
	applyAnswers,
	askClarify,
	clarifyChrome,
	clarifyNote,
	clarifyOpen,
	clarifyPlan,
	markClarify,
	readClarifyQuestions,
} from "../extensions/finisher/index.ts";

const DRAFTS = [
	{ goal: "", cases: [] },
	{ goal: "make it better", cases: [] },
	{ goal: "ปรับปรุงหน่อย", cases: [] },
	{ goal: "speed up the panel widget so it repaints under 16ms", cases: [] },
	{ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] },
	{ goal: "fix the flaky login test in test/login.test.mjs", cases: ["npm test exits 0"] },
	{ goal: "ทำให้ HUD เร็วขึ้น", cases: ["npm test ออกด้วย exit code 0"] },
];

const JUNK = [undefined, null, 0, 42, true, false, "", "   ", {}, [], ["", "  "], [{}, null, 3], [["a", "b"]]];

test("the harness owns no question: nothing it can be handed turns one of these drafts into a question", () => {
	assert.deepEqual(CLARIFY_MAX, 3, "the bound is the harness's; the words are not");
	assert.deepEqual(readClarifyQuestions(undefined), [], "a goal called with no clarify asks nothing");
	for (const junk of JUNK) assert.deepEqual(readClarifyQuestions(junk), [], `${JSON.stringify(junk)} is not a question`);
	const drafts = DRAFTS.concat([
		{ goal: "scan อีกครั้งต้องไม่เจอ .zense หรือ .finisher นอก ~/.pi", cases: [] },
		{ goal: "make it faster", cases: [] },
	]);
	for (const draft of drafts) {
		const plan = clarifyPlan(readClarifyQuestions(undefined), undefined, draft.goal?.toLowerCase() ?? "");
		assert.equal(plan.ask, false, `"${draft.goal}" is answered, not asked back at them`);
		assert.deepEqual(plan.questions, []);
	}
	assert.equal(CLARIFY_AS_IS, clarifyChrome("en").asIs, "even the escape the page offers is the agent's words, not a choice the harness invents");
});

test("a question the model wrote is the only thing that can be asked, bounded, deduped and never made up", () => {
	const asked = { question: "which of these did you mean?", options: ["the first", "the second"] };
	const one = readClarifyQuestions([asked]);
	assert.equal(one.length, 1);
	assert.deepEqual(one[0], asked, "the model's own words reach the page byte for byte");

	const many = Array.from({ length: 9 }, (_v, i) => ({ question: `q${i}?`, options: ["a", "b"] }));
	assert.equal(readClarifyQuestions(many).length, CLARIFY_MAX, "at most 3 questions, however many were offered");

	const wide = readClarifyQuestions([{ question: "q?", options: ["a", "b", "c", "d", "e", "f", "g"] }]);
	assert.equal(wide[0].options.length, CLARIFY_OPTIONS_MAX, "at most 5 choices");

	const deduped = readClarifyQuestions([
		{ question: "  which   one?  ", options: ["a", "a", "A", " b "] },
		{ question: "WHICH ONE?", options: ["x", "y"] },
		{ question: "q2?", options: [{}, 42, "only", null] },
		{ question: "", options: ["a", "b"] },
		{ question: "q3?", options: ["solo"] },
	]);
	assert.deepEqual(
		deduped.map((q) => [q.question, q.options]),
		[["which one?", ["a", "b"]]],
		"a duplicate question, a headerless one and one with a single reading are all dropped instead of being propped up",
	);

	assert.equal(readClarifyQuestions([{ question: "x".repeat(400), options: ["a", "b"] }])[0], undefined, "a question that is not one readable line is not asked");
	assert.deepEqual(readClarifyQuestions([{ question: "meaning", options: ["a", "b"] }])[0].gap, undefined);
	assert.equal(readClarifyQuestions([{ gap: "words", question: "which word?", options: ["a", "b"] }])[0].gap, "words", "the model may name which kind of doubt it has");
});

test("a goal is understood exactly once: the same goal never asks again, a changed one does", () => {
	const questions = readClarifyQuestions([{ question: "which one?", options: ["a", "b"] }]);
	const state = {};
	assert.equal(clarifyOpen(state, "k1"), true);
	assert.equal(clarifyPlan(questions, state, "k1").ask, true);
	markClarify(state, "k1", 42);
	assert.deepEqual(state.clarify, { goalKey: "k1", at: 42 });
	assert.equal(clarifyPlan(questions, state, "k1").ask, false, "one round per goal, and only one");
	assert.deepEqual(clarifyPlan(questions, state, "k1").questions, []);
	assert.equal(clarifyOpen(state, "k2"), true, "a different goal is a different doubt");
	assert.equal(clarifyPlan([], state, "k3").ask, false, "no question means no round at all");
});

test("the ask walks the questions in order and stops at the first escape instead of looping", async () => {
	const questions = readClarifyQuestions([
		{ question: "first?", options: ["a", "b"] },
		{ question: "second?", options: ["c", "d"] },
		{ question: "third?", options: ["e", "f"] },
	]);
	const seen = [];
	const answered = await askClarify(async (question) => {
		seen.push(question.question);
		return question.options[0];
	}, questions);
	assert.deepEqual(seen, ["first?", "second?", "third?"], "the model's order is the order, and nothing is asked twice");
	assert.deepEqual(answered.answers, { "first?": "a", "second?": "c", "third?": "e" }, "an answer is keyed by the question it answers");
	assert.equal(answered.stopped, false);
	assert.equal(answered.asked, 3);

	const escaped = await askClarify(async () => null, questions);
	assert.equal(escaped.stopped, true, "an escape stops the round");
	assert.equal(escaped.asked, 1, "and stops after the first question, not after all of them");
	assert.deepEqual(escaped.answers, {}, "nothing is invented from an escape");

	const asIs = await askClarify(async (question) => question.options.at(-1), readClarifyQuestions([{ question: "q?", options: ["a", CLARIFY_AS_IS] }]));
	assert.deepEqual(asIs.answers, {}, "picking 'as I said is enough' is not an answer");
	assert.equal(asIs.stopped, false, "but it is a choice, not a stall");
});

test("an answer lands on the case list only when it is checkable, and the goal key never drifts", () => {
	const questions = readClarifyQuestions([
		{ question: "which result?", options: ["npm test exits 0", "it feels right"] },
		{ question: "which word?", options: ["faster", "smaller"] },
	]);
	const applied = applyAnswers({ goal: "make it better", cases: [] }, questions, [{ question: "which result?", answer: "npm test exits 0" }]);
	assert.equal(applied.goal, "make it better", "the human's own words stay the goal");
	assert.deepEqual(applied.cases, ["npm test exits 0"], "a checkable answer becomes a case, so the run stands on what they settled");
	assert.deepEqual(applied.notes, [], "and is not repeated as a note");
	assert.deepEqual(applied.open, ["which word?"], "only the unanswered question stays open");

	const soft = applyAnswers({ goal: "make it better", cases: [] }, questions, [{ question: "which word?", answer: "faster" }]);
	assert.deepEqual(soft.cases, [], "an answer the harness cannot check never becomes a case");
	assert.deepEqual(soft.notes, ["which word? → faster"], "it is carried beside the goal instead");
	assert.match(soft.goalText, /which word\? → faster/);
	const overflow = applyAnswers({ goal: "make it better", cases: ["a.ts x", "b.ts x", "c.ts x", "d.ts x", "e.ts x"] }, questions, [{ question: "which result?", answer: "npm test exits 0" }]);
	assert.equal(overflow.cases.length, 5, "the case bound holds even when the answers are checkable");
	assert.deepEqual(overflow.notes, ["which result? → npm test exits 0"], "and the one that does not fit is kept, never dropped");

	const escaped = applyAnswers({ goal: "faster", cases: ["npm test"] }, questions, [
		{ question: "which result?", answer: CLARIFY_AS_IS },
		{ question: "which word?", answer: clarifyChrome("en").asIs },
	]);
	assert.deepEqual(escaped.goalText, "faster", "no note is written for an escape");
	assert.deepEqual(escaped.open, ["which result?", "which word?"], "and both questions stay open");

	const unmatched = applyAnswers({ goal: "faster", cases: [] }, questions, [{ question: "something else?", answer: "yes" }]);
	assert.deepEqual(unmatched.notes, [], "an answer with no question behind it is never kept");
});

test("the note speaks the human's language, counts what is left and names no question it was not given", () => {
	assert.match(clarifyNote(["which one?", "and how?"], "en"), /2 point\(s\)/, "the note keeps the count of what is still open");
	assert.match(clarifyNote(["which one?"], "th"), /[\u0E00-\u0E7F]/);
	assert.equal(clarifyNote([], "en"), "nothing to ask: I already read this goal the way you meant it");
	assert.equal(clarifyNote([], "th"), "ไม่ต้องถามเพิ่ม: ฉันเข้าใจ goal นี้ตรงกับที่คุณหมายไว้แล้ว");
	assert.doesNotMatch(clarifyNote([], "en"), /\?/, "a goal understood needs no question mark anywhere");
	assert.deepEqual(CLARIFY_CHROME_KEYS, ["title", "asIs", "later", "note"]);
	assert.equal(CLARIFY_RULE, clarifyChrome("th").note, "the rule the prompt quotes is the human's own");
});

test("the pipeline a goal really goes through is: model questions, they answer, the cases are untouched", () => {
	const goal = "scan อีกครั้งต้องไม่เจอ .zense หรือ .finisher นอก ~/.pi";
	const confirmed = ["รัน find แล้วไม่เจอ .zense หรือ .finisher นอก ~/.pi"];
	const plan = clarifyPlan(readClarifyQuestions(undefined), undefined, goal);
	assert.equal(plan.ask, false, "which is why this goal reached the confirm dialog with no question in front of it");
	assert.deepEqual(clarifyPlan([], undefined, goal).questions, []);
	const applied = applyAnswers({ goal, cases: confirmed }, plan.questions, []);
	assert.deepEqual(applied.cases, confirmed, "the cases the human confirms are the ones the run started with");
});

test("the source of the clarify module holds no canned question and no canned choice", async () => {
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const source = readFileSync(join(import.meta.dirname, "..", "extensions", "finisher", "src", "goal-clarify.ts"), "utf8");
	for (const banned of ["TH_MEANING", "EN_MEANING", "TH_OUTCOME", "EN_OUTCOME", "TH_WORD_TAIL", "EN_WORD_TAIL", "QUESTION_TEXT", "AMBIGUOUS_THAI", "AMBIGUOUS_LATIN", "VAGUE_WORDS", "clarifyGaps", "ambiguousWord", "decidable"])
		assert.ok(!source.includes(banned), `${banned} would be the harness guessing which question fits`);
	assert.doesNotMatch(source, /\boptions:\s*\[\s*"/, "no option list is written in the source");
	assert.doesNotMatch(source, /question:\s*"/, "the module authors no question text at all");
	assert.match(source, /export const checkableAnswer/, "what it does own is whether an answer can be checked at all");
});
