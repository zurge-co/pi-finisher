import { test } from "node:test";
import assert from "node:assert/strict";
import { breakGraphemes, graphemes, humanLanguage, languageGuideline, languageName, languageTag, languageVote, readableIn, resolveGoalLang, scriptKey, scriptVotes } from "../extensions/finisher/src/human-language.ts";

const THAI_MARK = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

const samples = ["ทำเลยครับ", "ทำให้ goal เป็นภาษาไทย", "日本語のゴール", "中文目标", "한국어 목표", "цель на русском", "الهدف بالعربية", "יעד בעברית", "लक्ष्य हिंदी में", "npm test && git status", "", "🎯🚀 1234", "ok"];

test("a written goal is broken only between graphemes, never through one", () => {
	for (const text of samples) {
		for (const limit of [1, 2, 3, 7]) {
			const chunks = breakGraphemes(text, limit);
			assert.equal(chunks.join(""), text, `every chunk must be returned in order for ${JSON.stringify(text)} @${limit}`);
			assert.ok(
				chunks.every((c) => graphemes(c).length <= limit),
				`saturating at ${limit} graphemes per chunk for ${JSON.stringify(text)} — got ${JSON.stringify(chunks)}`,
			);
			assert.ok(
				chunks.every((c) => !THAI_MARK.test(c[0] ?? "")),
				`a Thai mark must never begin a chunk for ${JSON.stringify(text)} @${limit} — got ${JSON.stringify(chunks)}`,
			);
		}
	}
});

test("the wrap bound is exact at the boundary", () => {
	const word = "กำลังทำ";
	const units = graphemes(word);
	assert.ok(units.length > 1, "the sample must be several graphemes");
	assert.deepEqual(breakGraphemes(word, units.length), [word], "exactly as many graphemes as the bound stays on one chunk");
	assert.equal(breakGraphemes(word, units.length - 1).length, 2, "one under the bound splits into two");
	assert.equal(breakGraphemes(word, 0).length, units.length, "a bound below one still splits by single graphemes");
});

test("the human's language is read from their script, and Latin never overrides it", () => {
	assert.equal(languageVote("ทำให้เป้าหมายเป็นภาษาไทยด้วย"), "th");
	assert.equal(languageVote("日本語で書いて"), "ja");
	assert.equal(languageVote("中文"), "zh");
	assert.equal(languageVote("한국어"), "ko");
	for (const latin of ["ok", "npm test && git status", "", "🎯 1234", "y"]) assert.equal(languageVote(latin), undefined, `${JSON.stringify(latin)} carries no other script, so it must not vote`);
	assert.equal(humanLanguage("th", "ok"), "th", "an English ack keeps the language the human already chose");
	assert.equal(humanLanguage("th", "เขียนภาษาไทย"), "th");
	assert.equal(humanLanguage(undefined, "ok"), "en");
	assert.equal(humanLanguage("th", "書いてください"), "ja", "a different script switches the language");
});

test("script votes are a total order: a dominant script wins and no text throws", () => {
	const messy = [...samples, "\uD800", "\u0000", "ทำ Thai ไทย ไทย", "あア亜", "aก1ข2"];
	for (const text of messy) {
		const votes = scriptVotes(text);
		for (let i = 1; i < votes.length; i++) assert.ok(votes[i - 1].letters >= votes[i].letters, `votes must be sorted for ${JSON.stringify(text)}`);
		const vote = languageVote(text);
		if (vote !== undefined) assert.ok(votes.some((v) => v.lang === vote && v.letters >= 2), `${JSON.stringify(text)} votes only for a script with real letters`);
	}
	assert.equal(languageVote("あア亜"), "ja", "kana makes the kanji Japanese, not Chinese");
	assert.equal(languageVote("中文目标"), "zh");
});

test("a goal is readable to the human only when it is written in their script", () => {
	assert.equal(readableIn("th", "ทำให้ goal เป็นภาษาไทย"), true);
	assert.equal(readableIn("th", "make the goal Thai"), false);
	assert.equal(readableIn("th", ""), false);
	assert.equal(readableIn("ja", "日本語のゴール"), true);
	assert.equal(readableIn(undefined, "anything at all"), true);
	assert.equal(readableIn("en", "anything at all"), true, "a Latin-script human can read Latin text, so nothing is refused");
	for (const text of samples) assert.equal(readableIn("th", text) && languageVote(text) === "th", languageVote(text) === "th", "readability in Thai cannot hold for text with no Thai in it");
});

test("the directive names the language and protects what must not be translated", () => {
	const th = languageGuideline("th");
	assert.ok(th.includes(languageName("th")) && th.includes("th"), "the directive must name the language the human writes");
	assert.ok(/paths, identifiers, commands/i.test(th), "paths and commands must stay untranslated");
	assert.notEqual(th, languageGuideline("en"));
	assert.ok(languageGuideline(undefined).includes("English"), "with no vote the contract is English");
});

test("the script the human actually typed decides, and the declared tag only refines it", () => {
	assert.equal(resolveGoalLang(undefined, "th"), "th");
	assert.equal(resolveGoalLang("pt-br", "th"), "th", "a Latin tag cannot overrule Thai the human really typed");
	assert.equal(resolveGoalLang("pt-br", undefined), "pt-br", "with no script evidence, the agent's tag is what we have");
	assert.equal(resolveGoalLang("pt-br", "en"), "pt-br", "two Latin languages are decided by the tag, not the script");
	assert.equal(resolveGoalLang("zh", "ja"), "ja", "a declared tag from another script loses to the human's own script");
	assert.equal(resolveGoalLang(undefined, undefined), "en");
	const pairs = [["th", "th"], ["pt-br", "th"], ["ja", "ja"], ["ru", "en"], ["el", "th"], [undefined, "ko"]];
	for (const [declared, voted] of pairs) assert.equal(scriptKey(resolveGoalLang(declared, voted)), scriptKey(voted ?? declared), `the resolved language keeps the human's script for ${declared}/${voted}`);
});

test("a language tag is normalised once and never invented", () => {
	assert.equal(languageTag("PT-br"), "pt-br");
	assert.equal(languageTag(" zh_Hant "), "zh-hant");
	for (const bad of ["", "   ", "!", "a", "th-TH-x", "klingon?", 42, null, undefined, {}]) assert.equal(languageTag(bad), undefined, `${JSON.stringify(bad)} is not a language tag`);
	for (const raw of ["th", "pt-BR", "zh_Hant", "en", "sr-Latn-RS"]) assert.equal(languageTag(languageTag(raw)), languageTag(raw), `normalisation is idempotent for ${raw}`);
});
