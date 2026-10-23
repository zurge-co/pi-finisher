import { test } from "node:test";
import assert from "node:assert/strict";
import { HYGIENE_MAX_LINES, buildCodeRulesPrompt, countLines, formatHygieneViolations, scanComments, scanLength } from "../extensions/finisher/index.ts";

const atLimit = Array.from({ length: HYGIENE_MAX_LINES }, (_, i) => `const v${i} = ${i};`).join("\n");

test("the line counter counts what a reader would count: no phantom line for a trailing newline", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("\n"), 1);
	assert.equal(countLines("a\nb"), 2);
	assert.equal(countLines("a\nb\n"), 2);
	assert.equal(countLines("a\n\n"), 2);
	assert.equal(countLines("a\n\nb"), 3);
});

test("the length rule is exact at the boundary and needs a reason to be waived", () => {
	assert.deepEqual(scanLength(atLimit, "a.ts"), []);
	assert.equal(scanLength(`${atLimit}\nconst one = 1;`, "a.ts").length, 1);
	assert.deepEqual(scanLength(`${atLimit}\nconst one = 1;\n// finisher-hygiene-allow: generated table`, "a.ts"), []);
	assert.equal(scanLength(`${atLimit}\nconst one = 1;\n// finisher-hygiene-allow`, "a.ts")[0].kind, "exempt-without-reason");
});

test("comment detection is a string-aware scan: what looks inside a literal is not a comment", () => {
	const literals = [
		`const a = "https://example.com//x";`,
		"const b = 'a // b';",
		"const c = `/* ${x} */`;",
		"const d = /a\\/\\/b/g;",
		"const e = 'it\\'s // not a comment';",
		'const f = "\\"//still a string\\"";',
	].join("\n");
	assert.deepEqual(scanComments(literals, "a.ts").violations, []);
});

test("every real comment form is found, and a block counts once per line it covers", () => {
	const cases = [
		["const a = 1;\n// tail comment\n", 1],
		["const a = 1; // inline comment\n", 1],
		["/* one line block */\nconst a = 1;\n", 1],
		["const a = 1;\n/*\n three\n lines\n*/\n", 4],
		["/* outer */ const a = 1; /* second */\n", 1],
	];
	for (const [text, expected] of cases) assert.equal(scanComments(text, "a.ts").violations.length, expected, text);
});

test("hash and dash languages only treat a line-leading marker as a comment", () => {
	assert.equal(scanComments("# note\nx = 1\n", "a.py").violations.length, 1);
	assert.equal(scanComments("x = '#1'\n", "a.py").violations.length, 0);
	assert.equal(scanComments("#!/bin/sh\necho hi\n", "a.sh").violations.length, 0);
	assert.equal(scanComments("-- note\nselect 1;\n", "a.sql").violations.length, 1);
	assert.equal(scanComments("; note\n(print 1)\n", "a.clj").violations.length, 1);
	assert.equal(scanComments("a // b\n", "a.rs").violations.length, 1);
});

test("non-code files are outside the rule", () => {
	assert.deepEqual(scanComments("// quoted in docs\n", "README.md").violations, []);
	assert.deepEqual(scanLength(Array.from({ length: 900 }, () => "x").join("\n"), "README.md"), []);
});

test("a violation report names the file, the line and the rule it broke", () => {
	const text = formatHygieneViolations([
		{ path: "a.ts", kind: "comment", line: 7, detail: "comment in .ts source" },
		{ path: "b.py", kind: "length", detail: "600 lines > 500 — split this file" },
	]);
	assert.match(text, /2 code-hygiene violation\(s\) in 2 file\(s\)/);
	assert.match(text, /a\.ts — 1 violation\(s\)\n\s+line 7: comment in \.ts/);
	assert.match(text, /b\.py — 1 violation\(s\)\n\s+600 lines > 500/);
	assert.equal(formatHygieneViolations([]), "");
});

test("the rule text the agent is given states both rules and the waiver form", () => {
	const p = buildCodeRulesPrompt();
	assert.match(p, /No comments in code/);
	assert.match(p, new RegExp(String(HYGIENE_MAX_LINES)));
	assert.match(p, /finisher-hygiene-allow: <why>/);
});
