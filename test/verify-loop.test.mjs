import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_VERIFY_ROUNDS,
	advanceLoop,
	buildFixPrompt,
	buildReport,
	nextVerifyRound,
	evidenceFingerprint,
	freshVerifyLoop,
	judgeCase,
	renderVerifyReport,
} from "../extensions/zense-harness/index.ts";

const passing = (id) => judgeCase(id, "$ npm test\nexit code 0\nVERDICT: PASS");
const failing = (id) => judgeCase(id, "$ npm test\nexit code 1\nVERDICT: FAIL");

const verdict = (caseId, text) => judgeCase(caseId, text);

const report = (...cases) => buildReport(cases);

test("PASS is impossible without an executed command, however loudly the verifier claims it", () => {
	assert.equal(verdict("c1", "VERDICT: PASS").verdict, "UNVERIFIED");
	assert.equal(verdict("c1", "I checked it carefully and it works.\nVERDICT: PASS").verdict, "UNVERIFIED");
	assert.equal(verdict("c1", "$ npm test\nexit code 0\nVERDICT: PASS").verdict, "PASS");
});

test("a non-zero exit anywhere is a FAIL even if the verifier says PASS", () => {
	assert.equal(verdict("c1", "$ npm test\nexit code 2\nVERDICT: PASS").verdict, "FAIL");
	assert.equal(verdict("c1", "$ npm test\nexit code 0\n$ npx tsc --noEmit\nexit code 1\nVERDICT: PASS").verdict, "FAIL");
});

test("declared FAIL is honoured, and silence after running commands is UNVERIFIED not PASS", () => {
	assert.equal(verdict("c1", "$ npm test\nexit code 0\nVERDICT: FAIL because the case is not covered").verdict, "FAIL");
	assert.equal(verdict("c1", "$ npm test\nexit code 0\n").verdict, "UNVERIFIED");
	assert.equal(verdict("c1", "$ npm test\nexit code 0\nVERDICT: PASS\nVERDICT: FAIL").verdict, "FAIL", "the last verdict wins");
});

test("the loop stops when the evidence stops changing, no matter how many rounds are left", () => {
	let state = freshVerifyLoop();
	const r1 = report(failing("c1"));
	assert.equal(nextVerifyRound(state, r1).kind, "retry");
	state = advanceLoop(state, r1);
	assert.equal(nextVerifyRound(state, r1).kind, "stop");
	assert.equal(nextVerifyRound(state, r1).halt, false);
});

test("the loop is bounded by rounds, and passing ends it immediately", () => {
	let state = freshVerifyLoop();
	let n = 0;
	for (;;) {
		const r = report(failing(`c${n++}`));
		const d = nextVerifyRound(state, r);
		if (d.kind !== "retry") {
			assert.equal(d.kind, "stop");
			assert.equal(d.halt, true);
			break;
		}
		state = advanceLoop(state, r);
		assert.ok(state.round <= MAX_VERIFY_ROUNDS, `round ${state.round} exceeded the bound`);
	}
	assert.equal(state.round, MAX_VERIFY_ROUNDS);
	const done = report(passing("c1"));
	assert.deepEqual(nextVerifyRound(state, done), { kind: "pass" });
	assert.equal(nextVerifyRound(freshVerifyLoop(), done).kind, "pass");
});

test("allPass is true only for a non-empty set of PASS verdicts", () => {
	assert.equal(buildReport([]).allPass, false, "an empty verification proves nothing");
	assert.equal(report(passing("c1"), failing("c2")).allPass, false);
	assert.deepEqual(report(passing("c1"), failing("c2")).failed, ["c2"]);
	assert.deepEqual(report(passing("c1"), verdict("c2", "no commands")).unverified, ["c2"]);
	assert.equal(report(passing("c1"), passing("c2")).allPass, true);
});

test("the fingerprint changes exactly when the evidence changes", () => {
	const a = report(verdict("c1", "$ npm test\nexit code 0\nVERDICT: PASS"));
	const b = report(verdict("c1", "$ npm test\nexit code 1\nVERDICT: FAIL"));
	const aAgain = report(verdict("c1", "$ npm test\nexit code 0\nVERDICT: PASS"), verdict("c2", "$ npx tsc --noEmit\nexit code 0\nVERDICT: PASS"));
	assert.notEqual(evidenceFingerprint(a), evidenceFingerprint(b));
	assert.notEqual(evidenceFingerprint(a), evidenceFingerprint(aAgain));
	assert.equal(evidenceFingerprint(a), evidenceFingerprint(report(verdict("c1", "$ npm test\nexit code 0\nVERDICT: PASS"))));
});

test("the fix prompt names the open cases, their evidence and forbids asking a human", () => {
	const p = buildFixPrompt(report(failing("c1"), verdict("c2", "no commands")), 2, 3);
	assert.match(p, /round 2\/3/);
	assert.match(p, /c1 \(FAIL\)/);
	assert.match(p, /c2 \(UNVERIFIED\): no command was run/);
	assert.match(p, /do not ask the human/);
	const rendered = renderVerifyReport(report(passing("c1"), failing("c2")));
	assert.match(rendered, /❌ not verified — 1 failing, 0 unproven of 2/);
	assert.match(rendered, /\$ npm test → exit 1/);
});
