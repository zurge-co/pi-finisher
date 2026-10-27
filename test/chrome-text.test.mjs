import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_TEXT_MAX, CLARIFY_CHROME_KEYS, GOAL_CHROME_KEYS, clarifyChrome, goalChrome } from "../extensions/finisher/index.ts";

const chromeLangs = ["en", "th", "ja", "zh", "pt-BR", "de", "zz", "!!", "", undefined];

test("no chrome table ever falls back to a language other than English, so nobody reads a language they did not ask for", () => {
	const english = { goal: goalChrome("en"), clarify: clarifyChrome("en") };
	for (const lang of chromeLangs) {
		const goal = goalChrome(lang);
		const clarify = clarifyChrome(lang);
		if (lang !== "th") {
			assert.deepEqual(goal, english.goal, `goal chrome for ${String(lang)} is English, never another language`);
			assert.deepEqual(clarify, english.clarify, `clarify chrome for ${String(lang)} is English, never another language`);
		}
	}
});

test("the agent's own chrome decides what a page says, in any language the table has no words for", () => {
	const supplied = { title: "▚ confirme uma vez", asIs: "como eu disse basta", later: "o resto se decide trabalhando", note: "pergunto uma vez, no máximo 3 questões" };
	const words = clarifyChrome("pt-BR", supplied);
	assert.deepEqual(words, supplied, "every supplied string is the words the page shows");
	assert.deepEqual(clarifyChrome("zz", supplied), supplied, "an unknown tag still speaks what the agent supplied");
	const english = clarifyChrome("en", { asIs: supplied.asIs, later: supplied.later });
	assert.equal(english.title, clarifyChrome("en").title, "a partial chrome only replaces what it supplies");
	assert.equal(english.note, clarifyChrome("en").note, "and never blanks the rest");
});

test("a chrome value is used only when it is one readable line, and the same rule holds for both pages", () => {
	const good = "x".repeat(CHROME_TEXT_MAX);
	const bad = ["", "   ", `${good}y`, "two\nlines", "a\tb", "a\u0007b", 42, null, undefined, {}];
	for (const key of GOAL_CHROME_KEYS) {
		const base = goalChrome("en");
		assert.equal(goalChrome("en", { [key]: good })[key], good, `goal ${key}: a value at the bound is usable`);
		for (const value of bad) assert.equal(goalChrome("en", { [key]: value })[key], base[key], `goal ${key}: ${JSON.stringify(value)} is not a label`);
	}
	for (const key of CLARIFY_CHROME_KEYS) {
		const base = clarifyChrome("en");
		assert.equal(clarifyChrome("en", { [key]: good })[key], good, `clarify ${key}: a value at the bound is usable`);
		for (const value of bad) assert.equal(clarifyChrome("en", { [key]: value })[key], base[key], `clarify ${key}: ${JSON.stringify(value)} is not a label`);
	}
});

test("the escape the human picks is the escape the answers refuse, in every language and for a supplied one", async () => {
	const { applyAnswers, clarifyChrome: chrome } = await import("../extensions/finisher/index.ts");
	for (const lang of ["en", "th"]) {
		const words = chrome(lang);
		const applied = applyAnswers({ goal: "make it better", cases: [] }, { meaning: words.asIs, outcome: words.asIs }, lang);
		assert.deepEqual(applied.notes, [], `${lang}: picking the escape answers nothing`);
		assert.deepEqual(applied.open, ["meaning", "words", "outcome"], `${lang}: so every gap is still open`);
	}
	const own = chrome("pt-BR", { asIs: "como eu disse basta" });
	const applied = applyAnswers({ goal: "make it better", cases: [] }, { meaning: own.asIs }, "pt-BR", { asIs: own.asIs });
	assert.deepEqual(applied.open, ["meaning", "words", "outcome"], "an agent-supplied escape is refused as an answer, exactly like the built-in one");
	assert.equal(applied.cases.includes(own.asIs), false, "and it never becomes a case the harness tries to check");
});

test("a human who does not read Thai is never handed Thai: every system note falls back to English for any other language", async () => {
	const m = await import("../extensions/finisher/index.ts");
	const THAI = /[\u0E00-\u0E7F]/;
	const notes = {
		consultNote: (lang) => m.consultNote(lang),
		noGoalNeededNote: (lang) => m.noGoalNeededNote("verify", lang),
		goalConsultNote: (lang) => m.goalConsultNote(lang),
		consultDirective: (lang) => m.consultDirective("why is it slow", lang),
		intakeDirective: (lang) => m.intakeDirective("ship the report page", lang, "work"),
		legacyNote: (lang) => m.legacyNote(["finisher_goal"], lang),
		legacyDirective: (lang) => m.legacyDirective("call finisher_goal", lang),
		legacyToolHint: (lang) => m.legacyToolHint("finisher_verify", lang),
		clarifyNote: (lang) => m.clarifyNote(["meaning", "outcome"], lang),
		goalStopMessage: (lang) => m.goalStopMessage({ reason: "declined", seconds: 5 }, lang),
	};
	for (const [name, note] of Object.entries(notes)) {
		assert.match(note("th"), THAI, `${name}: the Thai human reads Thai`);
		for (const lang of ["en", "ja", "pt-BR", "de", "zz", undefined]) {
			const text = note(lang);
			assert.ok(text.length > 0, `${name}: ${String(lang)} still gets a message`);
			assert.doesNotMatch(text, THAI, `${name}: ${String(lang)} is never served Thai`);
		}
	}
});

test("an agent-supplied clarify chrome reaches the question page and the note, so the round is in the human's own words", async () => {
	const m = await import("../extensions/finisher/index.ts");
	const chrome = { asIs: "como eu disse basta", note: "pergunto uma vez só", title: "▚ confirme", later: "depois decidimos" };
	const questions = m.clarifyQuestions(["meaning"], { goal: "make it better", cases: [] }, "pt-BR", chrome);
	assert.equal(questions[0].options.at(-1), chrome.asIs, "the escape is the agent's own words");
	assert.equal(questions[0].options.filter((o) => o === chrome.asIs).length, 1, "and it appears once");
	assert.match(m.clarifyNote(["meaning"], "pt-BR", chrome), /pergunto uma vez só/, "the rule the note quotes is the agent's own");
	const plan = m.clarifyPlan({ goal: "make it better", cases: [] }, {}, "k", "pt-BR", chrome);
	assert.equal(plan.questions[0].options.at(-1), chrome.asIs, "the plan carries the same words to the ask");
});
