import { test } from "node:test";
import assert from "node:assert/strict";
import {
	boundWrapper,
	buildReport,
	hasTimeoutBinary,
	isDeclaredFailure,
	judgeCase,
	repairNote,
	unusableCase,
	unusableCases,
} from "../extensions/finisher/index.ts";

test("a report that says nothing usable is repaired, never read as a failed case", () => {
	const unusable = [
		judgeCase("c1", "I looked at the change and it seems fine.\nVERDICT: PASS"),
		judgeCase("c2", "EVIDENCE:\nVERDICT: PASS"),
		judgeCase("c3", "node probe.mjs\nVERDICT: PASS"),
		judgeCase("c4", "EVIDENCE:\n$ node probe.mjs → exit 0\n$ node probe.mjs → exit 1\nVERDICT: PASS"),
	];
	for (const c of unusable) assert.equal(unusableCase(c), true, `${c.caseId}: ${c.reason}`);
	assert.equal(isDeclaredFailure(unusable[3]), false, "a self-contradictory verdict is a report problem, so it is asked for once more before it counts");
	for (const c of unusable.slice(0, 3)) assert.equal(isDeclaredFailure(c), false, "a missing status must not be blamed on the code");
	assert.deepEqual(unusableCases(buildReport(unusable)).map((c) => c.caseId), ["c1", "c2", "c3", "c4"]);
});

test("a real verdict is never repaired: pass, a declared failure, or an honestly unprovable case", () => {
	const pass = judgeCase("c1", "EVIDENCE:\n$ node probe.mjs → exit 0\nVERDICT: PASS");
	const fail = judgeCase("c2", "EVIDENCE:\n$ node probe.mjs → exit 1\nVERDICT: FAIL — the bound leaks");
	const human = judgeCase("c3", "VERDICT: UNVERIFIED — only a human can see the animation");
	assert.deepEqual(unusableCases(buildReport([pass, fail, human])), []);
	assert.equal(pass.verdict, "PASS");
	assert.equal(fail.verdict, "FAIL");
	assert.equal(human.verdict, "UNVERIFIED");
	assert.equal(isDeclaredFailure(human), false, "a human-only case is not a failure to fix");
});

test("the repair note tells the verifier how to fix the report, and never asks it to change the repo", () => {
	const note = repairNote([judgeCase("c1", "no evidence\nVERDICT: PASS")], "wrap it");
	assert.match(note, /FORMAT problem, not a code problem/);
	assert.match(note, /EVIDENCE:/);
	assert.match(note, /do not change the repo/);
	assert.match(note, /wrap it/, "the host's real deadline wrapper is handed over instead of being guessed");
	assert.match(note, /c1:/, "the note names the case that was unusable");
});

test("the deadline wrapper offered to a sub-agent matches what this host actually has", () => {
	const hint = boundWrapper();
	if (hasTimeoutBinary()) assert.match(hint, /timeout 120/);
	else assert.match(hint, /no `timeout` binary/);
	assert.match(hint, /120/, "the wrapper is shown with a concrete number, not a placeholder");
	assert.equal(boundWrapper(true).includes("perl"), false);
	assert.equal(boundWrapper(false).includes("perl"), true);
});
