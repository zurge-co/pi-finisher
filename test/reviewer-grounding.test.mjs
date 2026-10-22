import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReviewerPrompt, findUngroundedTokens } from "../extensions/zense-harness/index.ts";

const LASTEVAL = {
	verdict: "PASS",
	perCriteria: { c1: "PASS", c2: "PASS" },
	failedIds: [],
	probes: [
		{ id: "c1", status: "pass", exitCode: 0, detail: "npm test → PASS (exit 0, 71 tests)" },
		{ id: "c2", status: "pass", exitCode: 0, detail: "path exists: src/a.ts" },
	],
};
const CRITERIA = [
	{ id: "c1", text: "tests pass", check: "npm test" },
	{ id: "c2", text: "guard exists", check: "path exists: src/a.ts" },
];

test("buildReviewerPrompt: probes + criteria fed verbatim", () => {
	const p = buildReviewerPrompt("do x", LASTEVAL, [], [], [], "git log ...", "", undefined, CRITERIA);
	assert.match(p, /npm test → PASS \(exit 0, 71 tests\)/); 	assert.match(p, /tests pass \[check: npm test\]/); 	assert.match(p, /c1: PASS/);
	assert.match(p, /VERBATIM|verbatim/); 	assert.match(p, /Human actions/);
	assert.match(p, /zense_eval/); 	assert.match(p, /must not contradict/); });

test("findUngroundedTokens: catches identifiers/hashes/backticks absent from the evidence", () => {
	const packet = [
		"env var `ENTROPY_TIMEOUT_MINS` and flag `SUB_AGENT_KILLED` at index.ts:289",
		"commit `8f8b1f2` is still unmerged",
		"and `npm test` passed",
	].join("\n");
	const evidence = "constants: subagentTimeout, timedOut / commit 3879624 / npm test";
	const bad = findUngroundedTokens(packet, evidence, () => false);
	assert.ok(bad.includes("ENTROPY_TIMEOUT_MINS"));
	assert.ok(bad.includes("SUB_AGENT_KILLED"));
	assert.ok(bad.includes("8f8b1f2"));
	assert.ok(!bad.includes("npm test")); });

test("findUngroundedTokens: ignores PASS/OVERALL, evidence tokens and real paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-ground-"));
	try {
		writeFileSync(join(dir, "real.ts"), "x");
		const packet = "reviewed `real.ts:12` and `ghost.ts`, judgement is PASS per OVERALL";
		const evidence = "verdict PASS from the OVERALL line";
		const bad = findUngroundedTokens(packet, evidence, (p) => p === "real.ts");
		assert.ok(!bad.includes("real.ts:12")); 		assert.ok(bad.includes("ghost.ts")); 		assert.ok(!bad.includes("PASS") && !bad.includes("OVERALL")); 				assert.ok(findUngroundedTokens(packet, evidence).includes("real.ts:12"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
