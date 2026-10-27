import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	LEGACY_GUIDELINE,
	LEGACY_TOOL_NAMES,
	LEGACY_TOOL_RENAMES,
	SURFACE_TOOLS,
	isLegacyToolName,
	legacyDirective,
	legacyNamesIn,
	legacyNote,
	legacyRename,
	legacyRenamesIn,
	legacyToolHint,
	legacyToolName,
} from "../extensions/finisher/index.ts";

const THAI = /[\u0E00-\u0E7F]/;

test("every retired name renames to a live tool, and no name renames to another retired name", () => {
	assert.ok(LEGACY_TOOL_NAMES.length >= 4, "the rename map is the contract, so it cannot be empty");
	for (const legacy of LEGACY_TOOL_NAMES) {
		const now = legacyRename(legacy);
		assert.ok(now, `${legacy} must have a new name`);
		assert.ok(SURFACE_TOOLS.includes(now), `${legacy} → ${now}, and ${now} must be a real tool`);
		assert.equal(isLegacyToolName(now), false, `${now} is the live name, never a retired one`);
		assert.notEqual(now, legacy, "a rename that renames to itself would leave the old name live");
	}
	assert.equal(new Set(Object.values(LEGACY_TOOL_RENAMES)).size, LEGACY_TOOL_NAMES.length, "two old names never collapse onto one tool");
	assert.equal(legacyRename("goal"), undefined, "a live name is not a rename");
	assert.equal(legacyRename(""), undefined, "empty is nothing to rename");
	assert.equal(legacyToolName("finisher_gate"), undefined, "an unknown finisher_ word is not guessed into a tool");
});

test("detection is exact: every retired name in any text is found once, and a word that merely contains one is not", () => {
	for (const legacy of LEGACY_TOOL_NAMES) {
		assert.deepEqual(legacyNamesIn(`call ${legacy} now`), [legacy]);
		assert.deepEqual(legacyNamesIn(`CALL ${legacy.toUpperCase()} NOW`), [legacy], "case is not a convention the human has to know");
		assert.deepEqual(legacyNamesIn(`${legacy} then ${legacy} again`), [legacy], "a repeated name is listed once");
		assert.deepEqual(legacyNamesIn(`${legacy}s`), [], `"${legacy}s" is a different word`);
		assert.deepEqual(legacyNamesIn(`my${legacy}`), [], "a name glued to another word is not a call");
	}
	assert.deepEqual(legacyNamesIn("goal lap code verify steer"), [], "the live surface never reads as a rename");
	assert.deepEqual(legacyNamesIn(""), []);
	assert.deepEqual(legacyRenamesIn("use finisher_swarm and finisher_verify"), [
		{ from: "finisher_swarm", to: "code" },
		{ from: "finisher_verify", to: "verify" },
	]);
	assert.deepEqual(legacyRenamesIn("nothing here"), []);
});

test("every hint names the new name, so an old call is never a silent failure", () => {
	for (const legacy of LEGACY_TOOL_NAMES) {
		const now = LEGACY_TOOL_RENAMES[legacy];
		for (const lang of ["en", "th"]) {
			const hint = legacyToolHint(legacy, lang);
			assert.ok(hint.includes(now), `${lang} hint for ${legacy} must name ${now}`);
			const note = legacyNote([legacy], lang);
			assert.ok(note.includes(legacy) && note.includes(now), `${lang} note pairs the old name with ${now}`);
			const directive = legacyDirective(`please call ${legacy} with the cases`, lang);
			assert.ok(directive.includes(legacy) && directive.includes(now), `${lang} directive pairs the old name with ${now}`);
			assert.ok(!hint.includes("\n") && !note.includes("\n") && !directive.includes("\n"), "a hint is one painted line");
		}
	}
	assert.equal(legacyToolHint("goal", "th"), "", "the live name needs no hint");
	assert.equal(legacyNote([], "th"), "", "nothing to say about nothing");
	assert.equal(legacyDirective("just fix the panel", "th"), "", "a message with no retired name adds no directive");
	assert.equal(legacyDirective("", "en"), "");
});

test("the hints speak the human's language and never the other one", () => {
	for (const legacy of LEGACY_TOOL_NAMES) {
		assert.match(legacyToolHint(legacy, "th"), THAI, "Thai reaches the Thai human");
		assert.doesNotMatch(legacyToolHint(legacy, "en"), THAI, "English carries no Thai");
		assert.match(legacyNote([legacy], "th"), THAI);
		assert.doesNotMatch(legacyNote([legacy], "en"), THAI);
		assert.match(legacyDirective(`เรียก ${legacy}`, "th"), THAI);
		assert.doesNotMatch(legacyDirective(`call ${legacy}`, "en"), THAI);
	}
	assert.match(legacyToolHint("finisher_goal", "th-TH"), THAI, "a regional tag still reads as Thai");
});

test("the rule the prompt carries names every retired name and every live one, so the model cannot mistake a rename for a missing tool", () => {
	for (const legacy of LEGACY_TOOL_NAMES) assert.ok(LEGACY_GUIDELINE.includes(legacy), `the guideline must name ${legacy}`);
	for (const live of SURFACE_TOOLS) assert.ok(LEGACY_GUIDELINE.includes(live), `the guideline must name ${live}`);
	assert.match(LEGACY_GUIDELINE, /rename/, "the reading is a rename, not a missing tool");
	assert.match(LEGACY_GUIDELINE, /missing tool/, "and the failure it forbids is named");
	assert.doesNotMatch(LEGACY_GUIDELINE, THAI, "the system prompt is the harness's English, the per-turn directive is the human's");
});

test("the rename left no doubled name behind: no file says goal goal, code code, lap lap, verify verify or steer steer", () => {
	const root = new URL("..", import.meta.url).pathname;
	const files = ["README.md", "AGENTS.md", "extensions/finisher/index.ts", ...readdirSync(join(root, "extensions/finisher/src")).filter((f) => f.endsWith(".ts")).map((f) => `extensions/finisher/src/${f}`), ...readdirSync(join(root, "skills")).flatMap((d) => [`skills/${d}/SKILL.md`])];
	const doubled = [];
	for (const rel of files) {
		const src = readFileSync(join(root, rel), "utf8");
		for (const hit of src.matchAll(/\b(goal|lap|code|verify|steer)\s+\1\b/g)) doubled.push(`${rel}: ${hit[0]}`);
	}
	assert.deepEqual(doubled, [], "a doubled name is a rename that left one copy of the word in place — say it once");
});
