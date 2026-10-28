import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLARIFY_GUIDELINE, GOAL_FIRST_GUIDELINE, CONSULT_GUIDELINE, GOAL_DIALOG_SCROLL_KEYS, GOAL_SCROLL_KEYS, GOAL_WHEN_WORK_GUIDELINE, HARNESS_GUIDELINES, HARNESS_TOOLS, HYGIENE_MAX_BYTES, HYGIENE_MAX_LINES, INTENT_GUIDELINE, READ_WHOLE_FILE_GUIDELINE, SURFACE_TOOLS, WORK_FORCED_GUIDELINE, countOccurrences, harnessSystemPrompt, SWARM_ROUTING_GUIDELINE } from "../extensions/finisher/index.ts";
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
	const guidelines = HARNESS_GUIDELINES("th", "work");
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

test("the three turns differ in exactly their own rules, and no turn is told to decide and ordered to run at once", () => {
	const intentOwning = [INTENT_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE, GOAL_FIRST_GUIDELINE, WORK_FORCED_GUIDELINE, CLARIFY_GUIDELINE, CONSULT_GUIDELINE];
	for (const lang of ["th", "en", undefined]) {
		const [decide, consult, work] = [HARNESS_GUIDELINES(lang, "decide"), HARNESS_GUIDELINES(lang, "consult"), HARNESS_GUIDELINES(lang, "work")];
		const rest = (rules) => rules.filter((rule) => !intentOwning.includes(rule));
		assert.deepEqual(rest(decide), rest(consult), "only the leading rules differ between a decided turn and a conversation");
		assert.deepEqual(rest(decide), rest(work), "and between a decided turn and a forced one");

		assert.deepEqual(decide.slice(0, 3), [INTENT_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE, CLARIFY_GUIDELINE], "a decided turn reads the decision first, then the goal it owes only once decided");
		assert.deepEqual(consult.slice(0, 1), [CONSULT_GUIDELINE], "a conversation is one rule");
		assert.deepEqual(work.slice(0, 3), [WORK_FORCED_GUIDELINE, GOAL_FIRST_GUIDELINE, CLARIFY_GUIDELINE], "a forced turn reads the order first and never the decision");

		for (const rules of [decide, consult, work]) {
			assert.ok(!(rules.includes(INTENT_GUIDELINE) && rules.includes(WORK_FORCED_GUIDELINE)), "decide and forced-work are never both stated");
			assert.ok(!(rules.includes(CONSULT_GUIDELINE) && (rules.includes(GOAL_FIRST_GUIDELINE) || rules.includes(GOAL_WHEN_WORK_GUIDELINE))), "a conversation is never also told to confirm a goal");
			assert.ok(!(rules.includes(GOAL_FIRST_GUIDELINE) && rules.includes(GOAL_WHEN_WORK_GUIDELINE)), "a turn is never given two goal rules");
		}

		assert.match(GOAL_WHEN_WORK_GUIDELINE, /only once/i, "the decided turn's goal rule is conditional on the decision");
		assert.match(GOAL_WHEN_WORK_GUIDELINE, /conversation is answered, never armed/, "and it says what happens when the read is a conversation");
		assert.match(WORK_FORCED_GUIDELINE, /consultMode: off/, "the forced rule names the setting that forces it");
	}
	for (const [intent, goalRule] of [
		[undefined, GOAL_WHEN_WORK_GUIDELINE],
		["decide", GOAL_WHEN_WORK_GUIDELINE],
		["work", GOAL_FIRST_GUIDELINE],
	]) {
		const prompt = harnessSystemPrompt(base, "th", "", intent);
		assert.equal(countOccurrences(prompt, goalRule), 1, `exactly one goal rule reaches the prompt for ${String(intent)}`);
		assert.equal(countOccurrences(prompt, INTENT_GUIDELINE), intent === undefined || intent === "decide" ? 1 : 0, `the decision rule is stated only where the model decides (${String(intent)})`);
		assert.equal(harnessSystemPrompt(base, "th", "", intent).endsWith(languageGuideline("th")), true, "the language rule still closes the prompt");
	}
	assert.equal(countOccurrences(harnessSystemPrompt(base, "th", "", "consult"), CONSULT_GUIDELINE), 1, "the conversation rule reaches the prompt exactly once");
	for (const rule of [GOAL_FIRST_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE, INTENT_GUIDELINE, CLARIFY_GUIDELINE]) assert.equal(countOccurrences(harnessSystemPrompt(base, "th", "", "consult"), rule), 0);
	assert.equal(countOccurrences(harnessSystemPrompt(base, "th", "", "work"), WORK_FORCED_GUIDELINE), 1, "the forced rule reaches the forced prompt exactly once");
});

test("the decision rule names the model as the decider and never mentions a word list or a call budget", () => {
	assert.match(INTENT_GUIDELINE, /You decide what the human's message is/, "the decider is the model, stated plainly");
	assert.match(INTENT_GUIDELINE, /nothing in the harness inspects their words/, "and the harness promises it is not reading the words behind its back");
	assert.doesNotMatch(INTENT_GUIDELINE, /budget|grace|blocked|refused/i, "no call budget and no refusal survives in the rule the model reads");
	for (const forbidden of [/keyword/, /regex/, /match(es)? the word/i]) assert.doesNotMatch(INTENT_GUIDELINE, forbidden);
	for (const goalRule of [GOAL_FIRST_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE]) {
		assert.match(goalRule, /read (the code|to understand)/, "reading to understand the request is allowed before goal");
		assert.doesNotMatch(goalRule, /blocked|budget/i, "and is never gated by a spent budget");
	}
});

test("the read-whole-file rule reaches every turn and promises exactly the bound the scanner enforces", () => {
	for (const intent of [undefined, "decide", "consult", "work"]) {
		const prompt = harnessSystemPrompt(base, "th", "", intent);
		assert.equal(countOccurrences(prompt, READ_WHOLE_FILE_GUIDELINE), 1, `every turn is told a module comes back whole (${String(intent)})`);
	}
	assert.match(READ_WHOLE_FILE_GUIDELINE, new RegExp(`at or under ${HYGIENE_MAX_LINES} lines and ${HYGIENE_MAX_BYTES / 1024}KB`), "the number it promises is the number scanLength enforces");
	assert.match(READ_WHOLE_FILE_GUIDELINE, /offset/, "the call it rules out is named");
	assert.match(READ_WHOLE_FILE_GUIDELINE, /limit/, "both ways of paging a file that already fits");
	assert.doesNotMatch(READ_WHOLE_FILE_GUIDELINE, /usually|most files|sometimes/i, "a bound the agent may decide to ignore is not a bound");
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
