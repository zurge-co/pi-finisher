import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CLARIFY_AS_IS,
	CLARIFY_GAPS,
	CLARIFY_MAX,
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
import { askClarify, targetChoices } from "../extensions/finisher/index.ts";

const questionsFor = (gaps, draft, lang = "en", targets = []) => clarifyQuestions(gaps, draft, { targets }, lang);

test("the gaps are a bounded, ordered projection of the draft, never a second list", () => {
	const drafts = [
		{ goal: "", cases: [] },
		{ goal: "make it better", cases: [] },
		{ goal: "ปรับปรุงหน่อย", cases: [] },
		{ goal: "speed up the panel widget so it repaints under 16ms", cases: [] },
		{ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] },
		{ goal: "fix the flaky login test in test/login.test.mjs", cases: ["npm test exits 0"] },
	];
	for (const draft of drafts) {
		const gaps = clarifyGaps(draft);
		assert.ok(gaps.length <= CLARIFY_MAX, `at most ${CLARIFY_MAX} gaps, got ${gaps.length}`);
		assert.equal(new Set(gaps).size, gaps.length, "a gap is never asked twice");
		const order = gaps.map((gap) => CLARIFY_GAPS.indexOf(gap));
		assert.deepEqual(order, [...order].sort((a, b) => a - b), "the questions come in one fixed order");
		for (const gap of gaps) assert.ok(CLARIFY_GAPS.includes(gap));
	}
});

test("the observable gap is exactly the absence of a decidable case, in both directions", () => {
	const goals = ["make it better", "ปรับปรุงหน่อย", "speed up the panel widget"];
	const caseSets = [[], ["the goal holds"], ["all good"], ["npm test exits 0"], ["src/hud.ts drops the poll"], ["the goal holds", "`judgeCase` returns fail"]];
	for (const goal of goals) {
		for (const cases of caseSets) {
			const gaps = clarifyGaps({ goal, cases });
			assert.equal(gaps.includes("observable"), !cases.some(decidable), `goal "${goal}" cases ${JSON.stringify(cases)}`);
		}
	}
	assert.equal(decidable("the goal holds"), false, "a case with no anchor proves nothing");
	assert.equal(decidable("src/hud.ts drops the poll"), true, "a path is an anchor");
	assert.equal(decidable("npm test exits 0"), true, "a real command is an anchor");
	assert.equal(decidable("`judgeCase` returns fail"), true, "a backticked identifier is an anchor");
	assert.equal(decidable("< 16ms repaint"), true, "a bound is an anchor");
});

test("a goal whose words name nothing is ambiguous, and one with a real anchor is not", () => {
	for (const goal of ["ทำให้มันเร็วขึ้น", "make it better", "clean this up", "ปรับปรุงหน่อย", "faster", ""])
		assert.ok(clarifyGaps({ goal, cases: [] }).length > 0, `"${goal}" cannot be confirmed as written`);
	assert.deepEqual(clarifyGaps({ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] }), [], "the human already said what to change and how it is checked");
	assert.deepEqual(clarifyGaps({ goal: "fix the flaky login test in test/login.test.mjs", cases: ["npm test exits 0"] }), []);
});

test("every question offers a pick and the as-is escape last, and there are never more than three", () => {
	const draft = { goal: "ปรับปรุงหน่อย", cases: [] };
	const gaps = clarifyGaps(draft);
	for (const lang of ["en", "th"]) {
		const words = clarifyChrome(lang);
		const questions = questionsFor(gaps, draft, lang, ["hud.ts", "panel-widget.ts"]);
		assert.equal(questions.length, gaps.length, "one question per gap, none invented");
		assert.ok(questions.length <= CLARIFY_MAX);
		for (const question of questions) {
			assert.ok(question.options.length >= 2, "a question with one option is not a question");
			assert.equal(question.options.at(-1), words.asIs, "the escape is always the last option");
			assert.equal(question.options.filter((o) => o === words.asIs).length, 1, "and it appears once");
			assert.equal(new Set(question.options).size, question.options.length, "no option is offered twice");
		}
	}
	const thai = questionsFor(["target"], draft, "th", ["hud.ts"]);
	const english = questionsFor(["target"], draft, "en", ["hud.ts"]);
	assert.notEqual(thai[0].question, english[0].question, "the question is asked in the human's language");
	assert.match(thai[0].question, /[\u0E00-\u0E7F]/, "and it is really Thai, not a translated label");
	assert.deepEqual(questionsFor(["scope", "target"], draft, "en").map((q) => q.gap), ["target", "scope"], "the caller's order cannot reorder the gaps");
});

test("the answers are folded into cases the harness can check, and an unusable answer is never dropped", () => {
	assert.deepEqual(applyAnswers({ goal: "faster", cases: [] }, {}), { goal: "faster", goalText: "faster", cases: ["faster"], notes: [], open: ["target", "observable", "scope"] }, "no answer leaves the draft byte-identical, and still yields one case");
	const asIs = applyAnswers({ goal: "faster", cases: [] }, { target: CLARIFY_AS_IS, observable: clarifyChrome("th").asIs, scope: "   " });
	assert.equal(asIs.goal, "faster", "the human's own words stay the goal, so an unchanged goal still resumes");
	assert.deepEqual(asIs.open, ["target", "observable", "scope"], "the escape answers nothing");

	const concrete = applyAnswers({ goal: "make it better", cases: [] }, { observable: "npm test exits 0" });
	assert.deepEqual(concrete.cases, ["npm test exits 0"]);
	assert.equal(decidable(concrete.cases[0]), true, "a case the harness cannot check is never invented");

	const vague = applyAnswers({ goal: "make it better", cases: [] }, { target: "the file that owns the behaviour" });
	assert.deepEqual(vague.cases, ["make it better"], "an unverifiable answer never becomes a case");
	assert.match(vague.goalText, /target: the file that owns the behaviour/, "it is kept as a note instead of being dropped");
	assert.deepEqual(vague.notes, ["target: the file that owns the behaviour"]);
	assert.equal(vague.goal, "make it better", "and the goal key still does not drift");
	assert.deepEqual(vague.open, ["observable", "scope"]);

	const thai = applyAnswers({ goal: "ปรับปรุงหน่อย", cases: [] }, { target: "hud.ts", scope: "ทุกไฟล์ที่แตะ" }, "th");
	assert.match(thai.goalText, /ขอบเขต: ทุกไฟล์ที่แตะ/, "the note is labelled in the human's language");
	assert.deepEqual(thai.cases, ["hud.ts"], "a target that names a real module is a case");
	assert.deepEqual(thai.open, ["observable"]);

	const empty = applyAnswers({ goal: "", cases: [] }, {});
	assert.equal(empty.cases.length, 1, "a goal with nothing in it still cannot produce zero cases");
});

test("a goal is clarified exactly once: the same goal never asks again, a changed one does", () => {
	const draft = { goal: "make it better", cases: [] };
	const state = {};
	assert.equal(clarifyOpen(state, "k1"), true, "the first look asks");
	assert.equal(clarifyPlan(draft, state, "k1", { targets: [] }).ask, true);
	markClarify(state, "k1", 42);
	assert.deepEqual(state.clarify, { goalKey: "k1", at: 42 });
	assert.equal(clarifyOpen(state, "k1"), false, "one round per goal, and only one");
	assert.equal(clarifyPlan(draft, state, "k1", { targets: [] }).ask, false);
	assert.deepEqual(clarifyPlan(draft, state, "k1", { targets: [] }).questions, []);
	assert.equal(clarifyOpen(state, "k2"), true, "a different goal is a different question");
	assert.equal(clarifyPlan({ goal: "make the HUD ticker 20% faster in src/hud.ts", cases: ["npm test exits 0"] }, state, "k3", { targets: [] }).ask, false, "a goal that is already specific is never asked about");
});

test("the ask walks the questions in order and stops at the first escape instead of looping", async () => {
	const draft = { goal: "make it better", cases: [] };
	const questions = questionsFor(clarifyGaps(draft), draft, "en", ["hud.ts"]);
	const seen = [];
	const answered = await askClarify(async (question) => {
		seen.push(question.gap);
		return question.options[0];
	}, questions);
	assert.deepEqual(seen, questions.map((q) => q.gap), "the order is the caller's, and nothing is asked twice");
	assert.deepEqual(Object.keys(answered.answers), ["target", "observable", "scope"]);
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

test("the target options are the repo's own names, never a directory that only holds tooling", () => {
	const names = ["node_modules", ".git", "extensions", "hud.ts", "package.json", "extensions", "skills", "test", "themes"];
	assert.deepEqual(targetChoices(names, 3), ["extensions", "hud.ts", "package.json"], "hidden roots, tooling dirs and duplicates are dropped, and the cap holds");
	assert.deepEqual(targetChoices([], 3), [], "nothing is guessed when the tree is unreadable");
	assert.equal(targetChoices(["a", "b", "c", "d", "e"], 2).length, 2);
	assert.match(clarifyNote(["scope", "target"], "en"), /target, scope/, "the note keeps the fixed order");
	assert.match(clarifyNote(["target"], "th"), /[\u0E00-\u0E7F]/, "and speaks the human's language");
	assert.equal(clarifyNote([], "en"), "nothing to ask: this goal is specific enough to confirm");
});
