import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SUITE_GROWTH_MIN,
	countSuite,
	countTestCases,
	suiteBudget,
	suiteCeiling,
	suiteGrowth,
	suiteRefusal,
	suiteWriteGate,
} from "../extensions/finisher/src/suite-budget.ts";
import { STATE_HOME_LABEL } from "../extensions/finisher/index.ts";

const BASELINE = { files: 60, cases: 500 };

test("the ceiling boundary is exact: at it the suite is fine, one more is not", () => {
	const ceiling = suiteCeiling(BASELINE);
	assert.deepEqual(ceiling, { files: BASELINE.files + 1, cases: BASELINE.cases + Math.max(SUITE_GROWTH_MIN, Math.ceil(BASELINE.cases * 0.05)) });
	assert.equal(suiteBudget(BASELINE, ceiling).ok, true, "exactly at the ceiling is allowed");
	assert.equal(suiteBudget(BASELINE, { files: ceiling.files, cases: ceiling.cases + 1 }).ok, false);
	assert.equal(suiteBudget(BASELINE, { files: ceiling.files + 1, cases: ceiling.cases }).ok, false);
	assert.deepEqual(suiteBudget(BASELINE, { files: ceiling.files, cases: ceiling.cases + 1 }).over, ["test cases"]);
	assert.deepEqual(suiteBudget(BASELINE, { files: ceiling.files + 1, cases: ceiling.cases + 1 }).over, ["test files", "test cases"]);
});

test("the ceiling never shrinks below its baseline and always leaves room for the minimum growth", () => {
	for (const baseline of [{ files: 0, cases: 0 }, { files: 1, cases: 1 }, { files: 3, cases: 40 }, { files: 99, cases: 4000 }]) {
		const ceiling = suiteCeiling(baseline);
		assert.ok(ceiling.files > baseline.files);
		assert.ok(ceiling.cases >= baseline.cases + SUITE_GROWTH_MIN);
	}
	assert.deepEqual(suiteCeiling({ files: 0, cases: 0 }), { files: 1, cases: SUITE_GROWTH_MIN });
	assert.deepEqual(suiteCeiling({ files: -4, cases: Number.NaN }), { files: 1, cases: SUITE_GROWTH_MIN });
});

test("no baseline means no ceiling: the harness never asks for configuration", () => {
	for (const now of [{ files: 400, cases: 99_999 }, { files: 0, cases: 0 }]) {
		assert.equal(suiteBudget(undefined, now).ok, true);
		assert.equal(suiteBudget(undefined, now).note, "");
		assert.equal(suiteRefusal(undefined, now, "test/new.test.mjs"), undefined);
	}
});

test("growth is a delta that never goes negative", () => {
	assert.deepEqual(suiteGrowth({ files: 2, cases: 10 }, { files: 2, cases: 4 }), { files: 0, cases: 0 });
	assert.deepEqual(suiteGrowth({ files: 2, cases: 10 }, { files: 3, cases: 12 }), { files: 1, cases: 2 });
	assert.deepEqual(suiteGrowth(undefined, { files: 9, cases: 9 }), { files: 0, cases: 0 });
});

test("the refusal names the file and sends the proof to the check file, never to another test", () => {
	const refusal = suiteRefusal(BASELINE, { files: BASELINE.files, cases: 999 }, "test/extra.test.mjs");
	assert.equal(typeof refusal, "string");
	assert.ok(refusal.includes("test/extra.test.mjs"));
	assert.ok(refusal.includes(`${STATE_HOME_LABEL}/checks`), "the proof goes to the check file in the state home, never to another test");
	assert.match(refusal, /PASS/);
	assert.equal(suiteRefusal(BASELINE, { files: BASELINE.files + 1, cases: BASELINE.cases + SUITE_GROWTH_MIN }, "test/extra.test.mjs"), undefined);
});

test("countSuite measures a real tree and counts nothing outside the test directory", () => {
	const root = mkdtempSync(join(tmpdir(), "finisher-suite-"));
	try {
		mkdirSync(join(root, "test"), { recursive: true });
		writeFileSync(join(root, "test", "a.test.mjs"), ["test(\"one\", () => {});", "test(\"two\", () => {});", "test(\"three\", () => {});"].join("\n"));
		writeFileSync(join(root, "test", "b.spec.mjs"), ["test(\"four\", () => {});", "it(\"five\", () => {});"].join("\n"));
		writeFileSync(join(root, "test", "helper.mjs"), "test(\"not a case\", () => {});");
		writeFileSync(join(root, "test", "notes.md"), "test(\"not a case\", () => {});");
		assert.deepEqual(countSuite(root), { files: 2, cases: 5 });
		assert.deepEqual(countSuite(join(root, "nowhere")), { files: 0, cases: 0 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("countTestCases counts top-level declarations only, never a comment and never a name", () => {
	assert.equal(countTestCases("test(\"a\", () => {});\ntest(\"b\", () => {});"), 2);
	assert.equal(countTestCases("// test(\"gone\", () => {});\ntest(\"kept\", () => {});"), 1);
	assert.equal(countTestCases("const test = makeSuite();\ntest(\"real\", () => {});"), 1);
	assert.equal(countTestCases("describe(\"x\", () => { it(\"a\", () => {}); });"), 1);
	assert.equal(countTestCases(""), 0);
});

test("the baseline plus one file is the whole allowance: the second new file is refused, an existing one never is", () => {
	const root = mkdtempSync(join(tmpdir(), "finisher-suite-gate-"));
	try {
		mkdirSync(join(root, "test"), { recursive: true });
		writeFileSync(join(root, "test", "a.test.mjs"), "test(\"one\", () => {});");
		const baseline = countSuite(root);
		writeFileSync(join(root, "test", "b.test.mjs"), "test(\"two\", () => {});");
		assert.equal(suiteWriteGate(baseline, root, "test/b.test.mjs", false), undefined, "the one new file the ceiling allows stays allowed");
		writeFileSync(join(root, "test", "c.test.mjs"), "test(\"three\", () => {});");
		const refused = suiteWriteGate(baseline, root, "test/c.test.mjs", false);
		assert.match(String(refused), /test\/c\.test\.mjs/);
		assert.equal(suiteWriteGate(baseline, root, "test/a.test.mjs", true), undefined, "growing an existing file is not a new file");
		assert.equal(suiteWriteGate(baseline, root, "extensions/finisher/src/hud.ts", false), undefined, "only test files are gated");
		assert.equal(suiteWriteGate(undefined, root, "test/d.test.mjs", false), undefined, "no baseline means the gate never fires");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
