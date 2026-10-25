import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHECK_FILE_MAX,
	CHECK_OUTPUT_MAX,
	appendCheck,
	caseChecks,
	caseStatus,
	checkFileLines,
	checkMark,
	checksDir,
	checksPath,
	encodeCheck,
	parseCheckLine,
	parseChecks,
	readChecks,
	renderCheckFile,
	writeChecks,
} from "../extensions/finisher/src/check-file.ts";

const tempRepo = () => {
	const root = mkdtempSync(join(tmpdir(), "finisher-checks-"));
	return { root, drop: () => rmSync(root, { recursive: true, force: true }) };
};

const ENTRY = { at: 1_700_000_000_000, case: "the widget renders below the editor", status: "pass" };

test("every record survives its own encoding, with the output capped and nothing invented", () => {
	const long = `${"a".repeat(2000)}THE-END`;
	const table = [
		ENTRY,
		{ ...ENTRY, goal: "make it faster", command: "npm test", output: "ok" },
		{ ...ENTRY, status: "fail", output: long },
		{ ...ENTRY, case: "แก้บั๊กตอน logout ในภาษาไทย", status: "infra" },
		{ ...ENTRY, status: "deadline", output: "timed out" },
		{ ...ENTRY, status: "unverified" },
	];
	for (const entry of table) {
		const line = encodeCheck(entry);
		assert.ok(!line.includes("\n"), "one record is one line");
		const back = parseCheckLine(line);
		const expected = entry.output && entry.output.length > CHECK_OUTPUT_MAX ? { ...entry, output: entry.output.slice(-CHECK_OUTPUT_MAX) } : entry;
		assert.deepEqual(back, expected);
	}
	assert.equal(parseCheckLine(encodeCheck({ ...ENTRY, output: long })).output.length, CHECK_OUTPUT_MAX);
	assert.ok(parseCheckLine(encodeCheck({ ...ENTRY, output: long })).output.endsWith("THE-END"), "the tail is what survives");
});

test("a junk line never breaks a read and never proves a case", () => {
	const valid = encodeCheck(ENTRY);
	const damaged = [
		"null",
		"[1,2,3]",
		"",
		"{truncated",
		JSON.stringify({ ...ENTRY, status: "probably" }),
		JSON.stringify({ ...ENTRY, case: "  " }),
		JSON.stringify({ ...ENTRY, at: "yesterday" }),
	].join("\n");
	assert.deepEqual(parseChecks([valid, damaged, valid].join("\n")).length, 2);
	assert.deepEqual(parseChecks(""), []);
	assert.equal(parseCheckLine("{}"), undefined);
	assert.equal(parseCheckLine(undefined), undefined);
});

test("the check file is bounded: the newest records survive and the oldest are dropped", () => {
	const { root, drop } = tempRepo();
	try {
		for (let i = 0; i < CHECK_FILE_MAX + 25; i++) assert.equal(appendCheck(root, { ...ENTRY, at: i, case: `case ${i}` }), true);
		const onDisk = readFileSync(checksPath(root), "utf8").split("\n").filter(Boolean);
		assert.equal(onDisk.length, CHECK_FILE_MAX);
		const entries = readChecks(root);
		assert.equal(entries.length, CHECK_FILE_MAX);
		assert.equal(entries[0].case, "case 25", "the oldest 25 records are gone");
		assert.equal(entries[entries.length - 1].case, `case ${CHECK_FILE_MAX + 24}`);
		assert.equal(checksPath(root), join(checksDir(root), "checks.jsonl"));
	} finally {
		drop();
	}
});

test("a missing check file reads as no evidence instead of crashing", () => {
	const { root, drop } = tempRepo();
	try {
		assert.deepEqual(readChecks(root), []);
		assert.equal(existsSync(checksPath(root)), false);
		assert.equal(writeChecks(root, []), true);
		assert.deepEqual(readChecks(root), []);
	} finally {
		drop();
	}
});

test("the newest record for a case wins, a re-spaced copy still matches, and no record is never a pass", () => {
	const entries = [
		{ ...ENTRY, at: 1, status: "pass" },
		{ ...ENTRY, at: 2, status: "fail" },
		{ ...ENTRY, at: 3, case: "another   case", status: "pass" },
	];
	assert.equal(caseStatus(entries, "the widget renders below the editor"), "fail");
	assert.equal(caseStatus(entries, "  the   widget renders below the editor "), "fail");
	assert.equal(caseStatus(entries, "another case"), "pass");
	assert.equal(caseStatus(entries, "never recorded"), "unverified");
	assert.equal(caseStatus([], "never recorded"), "unverified");
	assert.deepEqual(caseChecks(entries, ["never recorded", "another case"]), [
		{ caseId: "never recorded", status: "unverified" },
		{ caseId: "another case", status: "pass" },
	]);
});

test("every status has its own mark and only a real pass says PASS", () => {
	assert.deepEqual(["pass", "fail", "infra", "deadline", "unverified"].map(checkMark), ["PASS", "FAIL", "SKIP", "SKIP", "UNVERIFIED"]);
	assert.equal(checkMark(undefined), "UNVERIFIED");
});

test("the human-readable check file keeps one line per case and never truncates the case itself", () => {
	const longCase = `the ${"very ".repeat(50)}long case text`.trim();
	const entries = [
		{ ...ENTRY, case: longCase, status: "pass", goal: "ship it" },
		{ ...ENTRY, case: "second case", status: "fail", goal: "ship it" },
	];
	const cases = [longCase, "second case", "unrecorded case"];
	const lines = checkFileLines(entries, cases);
	assert.equal(lines.length, 3, "one line per case, in case order");
	assert.ok(lines[0].startsWith("PASS  ") && lines[0].includes(longCase), "the whole case text is on its line");
	assert.ok(lines[1].startsWith("FAIL  "));
	assert.ok(lines[2].startsWith("UNVERIFIED  "));
	assert.ok(!lines.some((line) => line.includes("\n")));
	const rendered = renderCheckFile(entries, cases);
	assert.ok(rendered.startsWith("goal: ship it"), "the shared goal heads the file");
	assert.equal(rendered.split("\n").length, 1 + 1 + 3);
	assert.ok(!rendered.endsWith("\n"));
	assert.equal(checkFileLines(entries).length, 2, "without a case list every recorded case is listed once");
});
