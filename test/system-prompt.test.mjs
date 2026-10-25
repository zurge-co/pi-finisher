import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_GUIDELINES, countOccurrences, harnessSystemPrompt } from "../extensions/finisher/index.ts";
import { languageGuideline } from "../extensions/finisher/src/human-language.ts";

const base = "you are a coding agent";

test("every turn carries each harness guideline exactly once, behind the base prompt", () => {
	for (const lang of ["th", "ja", "pt-br", undefined]) {
		const prompt = harnessSystemPrompt(base, lang);
		assert.equal(countOccurrences(prompt, base), 1, "the host prompt is kept, not duplicated");
		for (const guideline of HARNESS_GUIDELINES(lang)) assert.equal(countOccurrences(prompt, guideline), 1, `each guideline appears once for ${String(lang)}`);
		assert.ok(prompt.startsWith(base), "the host prompt stays first so the harness rules read as additions");
		assert.equal(prompt, harnessSystemPrompt(base, lang), "composition is a function of its inputs, not of history");
	}
});

test("the language directive is the human's, and it is the last rule the agent reads", () => {
	const prompt = harnessSystemPrompt(base, "th");
	assert.ok(prompt.endsWith(languageGuideline("th")), "the language rule is appended last, after the generic rules");
	assert.notEqual(prompt, harnessSystemPrompt(base, "en"), "a different human language is a different prompt");
	assert.ok(harnessSystemPrompt(base, "en").endsWith(languageGuideline("en")));
	for (const lang of ["th", "ko", "ar"]) assert.ok(harnessSystemPrompt(base, lang).includes(lang), `the prompt names the language it demands for ${lang}`);
});

test("the goal-first rule is followed by the clarify rule, which bounds the questions instead of inviting an interview", () => {
	const guidelines = HARNESS_GUIDELINES("th");
	const at = guidelines.findIndex((rule) => /at most 3 questions/.test(rule));
	assert.equal(at, 1, "the clarify rule sits directly behind the goal-first rule");
	assert.match(guidelines[at], /as I said is enough/, "the escape the human always has");
	assert.match(guidelines[at], /reading the code would answer/, "and the questions the harness may never ask");
	assert.match(guidelines[at], /never run a second round/, "the bound is one round per goal");
	assert.ok(harnessSystemPrompt(base, "th").includes(guidelines[at]), "and it really reaches the prompt the model reads");
});

test("a context bulletin rides along once and only when there is one", () => {
	const bulletin = "the repo already has a release script";
	const withBulletin = harnessSystemPrompt(base, "th", bulletin);
	assert.equal(countOccurrences(withBulletin, bulletin), 1);
	assert.ok(withBulletin.endsWith(bulletin), "the bulletin is the freshest thing in the prompt");
	assert.equal(harnessSystemPrompt(base, "th"), harnessSystemPrompt(base, "th", ""), "an empty bulletin leaves no gap behind");
	assert.ok(withBulletin.length > harnessSystemPrompt(base, "th").length);
});
