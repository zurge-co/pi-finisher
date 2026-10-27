import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLARIFY_GUIDELINE, GOAL_FIRST_GUIDELINE, CONSULT_GUIDELINE, GOAL_DIALOG_SCROLL_KEYS, GOAL_SCROLL_KEYS, HARNESS_GUIDELINES, HARNESS_TOOLS, INTENT_GUIDELINE, SURFACE_TOOLS, countOccurrences, harnessSystemPrompt, SWARM_ROUTING_GUIDELINE } from "../extensions/finisher/index.ts";
import { languageGuideline } from "../extensions/finisher/src/human-language.ts";

const base = "you are a coding agent";
const here = new URL("..", import.meta.url).pathname;

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

test("the goal-first rule is followed by the clarify rule, which confirms understanding instead of inviting an interview", () => {
	const guidelines = HARNESS_GUIDELINES("th");
	const at = guidelines.findIndex((rule) => /at most 3 questions/.test(rule));
	assert.equal(guidelines[at - 1], GOAL_FIRST_GUIDELINE, "the clarify rule sits directly behind the goal-first rule");
	assert.ok(at > 0, "and the goal-first rule is the thing in front of it");
	assert.match(guidelines[at], /as I said is enough/, "the escape the human always has");
	assert.match(guidelines[at], /reading the code would answer/, "and the questions the harness may never ask");
	assert.match(guidelines[at], /once per goal/, "the bound is one round per goal");
	assert.match(guidelines[at], /understood the way the human meant it/, "the round is about understanding, nothing else");
	assert.match(guidelines[at], /never ask how the work is done and never ask how far it reaches/i, "never the method and never the scope");
	assert.doesNotMatch(guidelines[at], /how should the result be checked|how far should the change reach/, "the retired questions are gone from the rule the model reads");
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

test("the routing guideline states the coder floor and that main codes alongside them", () => {
	const guideline = SWARM_ROUTING_GUIDELINE;
	assert.match(guideline, /lone CODER/i, "a lone coder is named as the thing never spawned");
	assert.match(guideline, /at least two run side by side/, "the floor is two running side by side");
	assert.match(guideline, /fewer than two slices is refused/, "and the refusal is the floor, not advice");
	assert.match(guideline, /main/i);
	assert.match(guideline, /IN THE SAME TURN/, "main's own slice overlaps the fan-out instead of waiting");
	const prompt = harnessSystemPrompt(base, "th");
	assert.equal(countOccurrences(prompt, guideline), 1, "the routing rule reaches the prompt exactly once");
	const goalAt = guideline.indexOf("goal confirms once");
	const lapAt = guideline.indexOf("lap declares the plan");
	const verifyAt = guideline.indexOf("verify exactly once");
	assert.ok(goalAt >= 0 && goalAt < lapAt && lapAt < verifyAt, "the fixed workflow still reads goal → lap → verify");
});

test("the work turn states that the model decides the turn, and consult mode swaps that for the conversation rule", () => {
	for (const lang of ["th", "en", undefined]) {
		const consult = HARNESS_GUIDELINES(lang, "consult");
		const work = HARNESS_GUIDELINES(lang, "work");
		assert.ok(consult.includes(CONSULT_GUIDELINE));
		assert.ok(!consult.includes(INTENT_GUIDELINE), "the conversation is forced by the human, so there is nothing left to decide");
		assert.ok(!consult.includes(GOAL_FIRST_GUIDELINE), "and no goal is demanded in it");
		assert.ok(!consult.includes(CLARIFY_GUIDELINE), "and the clarify round is not run");
		assert.ok(work.includes(INTENT_GUIDELINE), "a normal turn tells the model that the decision is its own");
		assert.ok(work.includes(GOAL_FIRST_GUIDELINE), "and that the run starts at goal");
		assert.deepEqual(
			consult.filter((rule) => rule !== CONSULT_GUIDELINE),
			work.filter((rule) => rule !== INTENT_GUIDELINE && rule !== GOAL_FIRST_GUIDELINE && rule !== CLARIFY_GUIDELINE),
			"only the first rules differ: hygiene, routing, proof, timeout and language are the same",
		);
	}
	for (const intent of [undefined, "work"]) {
		const prompt = harnessSystemPrompt(base, "th", "", intent);
		assert.equal(countOccurrences(prompt, GOAL_FIRST_GUIDELINE), 1, `goal-first reaches the prompt exactly once for ${String(intent)}`);
		assert.equal(countOccurrences(prompt, INTENT_GUIDELINE), 1, `the decision rule reaches the prompt exactly once for ${String(intent)}`);
	}
	assert.equal(countOccurrences(harnessSystemPrompt(base, "th", "", "consult"), CONSULT_GUIDELINE), 1, "the conversation rule reaches the prompt exactly once");
	assert.equal(countOccurrences(harnessSystemPrompt(base, "th", "", "consult"), GOAL_FIRST_GUIDELINE), 0);
	assert.ok(harnessSystemPrompt(base, "th", "", "consult").endsWith(languageGuideline("th")), "the language rule still closes the prompt");
});

test("the decision rule names the model as the decider and never mentions a word list or a call budget", () => {
	assert.match(INTENT_GUIDELINE, /You decide what the human's message is/, "the decider is the model, stated plainly");
	assert.match(INTENT_GUIDELINE, /nothing in the harness inspects their words/, "and the harness promises it is not reading the words behind its back");
	assert.doesNotMatch(INTENT_GUIDELINE, /budget|grace|blocked|refused/i, "no call budget and no refusal survives in the rule the model reads");
	for (const forbidden of [/keyword/, /regex/, /match(es)? the word/i]) assert.doesNotMatch(INTENT_GUIDELINE, forbidden);
	assert.match(GOAL_FIRST_GUIDELINE, /you may read to understand the message/, "reading to understand the request is allowed before goal");
	assert.doesNotMatch(GOAL_FIRST_GUIDELINE, /blocked|budget/i, "and is never gated by a spent budget");
});

test("no sentence the harness says out loud is written down twice, so a rename cannot leave a copy behind", () => {
	const src = join(here, "extensions", "finisher");
	const files = [join(src, "index.ts"), ...readdirSync(join(src, "src")).filter((f) => f.endsWith(".ts")).map((f) => join(src, "src", f))];
	const owners = new Map();
	for (const file of files)
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (/^\s*import\b/.test(line)) continue;
			for (const hit of line.matchAll(/"((?:[^"\\]|\\.){45,})"|`([^`]{45,})`/g)) {
				const text = hit[1] ?? hit[2];
				if (/\$\{/.test(text) || (text.match(/\s/g) ?? []).length < 3) continue;
				const where = file.slice(here.length);
				owners.set(text, [...(owners.get(text) ?? []), where]);
			}
		}
	const shared = [...owners].map(([text, files]) => [text, [...new Set(files)]]).filter(([, files]) => files.length > 1);
	assert.deepEqual(shared.map(([text, files]) => `${files.join(" + ")}: ${text.slice(0, 70)}`), [], "two modules holding the same sentence drift apart on the next edit — export it from one and import it");
});

test("the surfaces the rename folded together are one value, so two modules cannot disagree about them", () => {
	assert.equal(GOAL_DIALOG_SCROLL_KEYS, GOAL_SCROLL_KEYS, "the dialog advertises the keys the chrome table paints");
	assert.equal(HARNESS_TOOLS, SURFACE_TOOLS, "the tools a coder is denied are the ones the harness registers");
});
