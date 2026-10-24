import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_TEXT_MAX, goalChrome, goalConfirmLines } from "../extensions/finisher/index.ts";

const goal = "ทำให้ goal dialog เป็นภาษาของคนที่อ่าน";
const cases = ["ข้อแรกเป็นจริงกับผลลัพธ์จริง", "ข้อสองเป็นจริงกับผลลัพธ์จริง", "ข้อสามเป็นจริงกับผลลัพธ์จริง"];

const shape = (lines) => lines.map((l) => l.kind);

test("no language and no override can ever rewrite the goal or a case", () => {
	const base = goalConfirmLines(goal, cases);
	const hostile = [
		undefined,
		"en",
		"th",
		"ja",
		"pt-BR",
		"zz",
		"",
		{ header: "x".repeat(CHROME_TEXT_MAX + 1) },
		{ note: "two\nlines" },
		{ title: "   " },
		{ goal: "replaced", header: "แทนที่หัวข้อ", note: "แทนที่หมายเหตุ" },
		{ keys: "\u0000" },
	];
	for (const variant of hostile) {
		const lines = typeof variant === "string" || variant === undefined ? goalConfirmLines(goal, cases, variant) : goalConfirmLines(goal, cases, "th", variant);
		assert.deepEqual(shape(lines), shape(base), `the dialog keeps its shape for ${JSON.stringify(variant)}`);
		assert.equal(lines.find((l) => l.kind === "goal").text, goal, `the goal is shown exactly as confirmed for ${JSON.stringify(variant)}`);
		assert.deepEqual(
			lines.filter((l) => l.kind === "case").map((l) => l.text),
			cases.map((c, i) => `${i + 1}. ${c}`),
			`every case is shown, numbered in order, for ${JSON.stringify(variant)}`,
		);
	}
});

test("the chrome follows the declared language, falls back by base tag, and never invents one", () => {
	const english = goalChrome("en");
	const thai = goalChrome("th");
	assert.notEqual(thai.header, english.header, "a supported language is not served English chrome");
	assert.notEqual(thai.keys, english.keys);
	for (const tag of ["en-GB", "pt-BR", "sr-Latn", "zh-Hant"]) assert.deepEqual(goalChrome(tag), goalChrome(tag.split("-")[0]), `${tag} resolves through its base tag`);
	for (const tag of [undefined, "", "zz", "!!", "klingon"]) assert.deepEqual(goalChrome(tag), english, `${String(tag)} is not a language we know, so the chrome is the default one`);
	const supplied = goalChrome("pt-BR", { header: "A meta está cumprida quando:", note: "Depois de confirmar: sem mais aprovação.", title: "▚ confirme uma vez" });
	assert.equal(supplied.header, "A meta está cumprida quando:", "the agent's own translation wins over the fallback");
	assert.equal(supplied.keys, english.keys, "a chrome pair only replaces what it supplies");
});

test("a supplied chrome string is used only when it is one readable line", () => {
	const base = goalChrome("th");
	const long = "y".repeat(CHROME_TEXT_MAX);
	assert.equal(goalChrome("th", { header: long }).header, long, "a label at the bound is usable");
	assert.equal(goalChrome("th", { header: `${long}y` }).header, base.header, "one over the bound is refused, not truncated");
	for (const bad of ["", "   ", "a\nb", "a\tb", "a\u0007b", 42, null, undefined]) assert.equal(goalChrome("th", { header: bad }).header, base.header, `${JSON.stringify(bad)} is not a label`);
});
