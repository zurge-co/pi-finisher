import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFanOutPrompt } from "../extensions/finisher/index.ts";
import {
	buildHumanTestNote,
	buildReplanPrompt,
	buildReport,
	decideOnce,
	freshAttempts,
	judgeCase,
	MAX_LOOP_BATCHES,
	renderVerifyReport,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const pass = (id) => judgeCase(id, `$ node -e "run()"\nexit code 0\nVERDICT: PASS`);
const fail = (id) => judgeCase(id, `$ node -e "run()"\nexit code 1\nVERDICT: FAIL`);
const unverified = (id) => judgeCase(id, "VERDICT: UNVERIFIED — needs a browser");

test("a single verification pass decides the whole run — there is no per-round retry machine", () => {
	const src = readFileSync(join(here, "extensions/finisher/src/verify-loop.ts"), "utf8");
	for (const gone of ["MAX_VERIFY_ROUNDS", "nextVerifyRound", "advanceLoop", "caseRounds"]) assert.ok(!src.includes(gone), `${gone} must be gone`);
	assert.match(src, /decideOnce/);
});

test("all cases proven → pass", () => {
	const d = decideOnce(buildReport([pass("c1"), pass("c2")]), freshAttempts());
	assert.deepEqual(d, { kind: "pass" });
});

test("a failed case asks the main agent to plan another loop, and names the case", () => {
	const report = buildReport([pass("c1"), fail("c2")]);
	const d = decideOnce(report, freshAttempts());
	assert.equal(d.kind, "replan");
	const prompt = buildReplanPrompt(report, "ship it");
	assert.match(prompt, /c2/);
	assert.match(prompt, /plan the next loop/);
	assert.match(prompt, /do not re-run the test suite as proof/);
});

test("nothing that could be exercised → do nothing else and tell the human to test", () => {
	const report = buildReport([unverified("c1")]);
	const d = decideOnce(report, freshAttempts());
	assert.equal(d.kind, "human");
	const note = buildHumanTestNote(report);
	assert.match(note, /needs a human/);
	assert.match(note, /c1/);
	assert.match(note, /nothing else was run/);
	assert.equal(report.allPass, false);
	assert.deepEqual(report.failed, [], "not being provable is not the same as failing");
});

test("a declared UNVERIFIED is respected instead of being read as a weak PASS", () => {
	const c = judgeCase("c1", `$ curl localhost:1\nexit code 0\nVERDICT: UNVERIFIED — it needs a browser`);
	assert.equal(c.verdict, "UNVERIFIED");
	assert.match(c.reason ?? "", /human must test/);
});

test("an unproven case can never become a pass without a command", () => {
	assert.equal(judgeCase("c1", "I looked at the diff and it seems fine").verdict, "UNVERIFIED");
	assert.equal(judgeCase("c1", "VERDICT: PASS").verdict, "UNVERIFIED", "a declaration alone is not evidence");
});

test("the loop cannot spin forever: after the attempt bound it halts and says why", () => {
	let attempts = freshAttempts();
	const actions = [];
	for (let i = 0; i < MAX_LOOP_BATCHES + 1; i++) {
		const d = decideOnce(buildReport([fail("c1")]), attempts);
		actions.push(d.kind);
		attempts = { ...attempts, rounds: attempts.rounds + 1 };
	}
	assert.deepEqual(actions.slice(0, -1), Array(MAX_LOOP_BATCHES).fill("replan"));
	assert.equal(actions.at(-1), "halt");
	const last = decideOnce(buildReport([fail("c1")]), attempts);
	assert.equal(last.kind, "halt");
	assert.match(last.reason, /stopping instead of looping forever/);
});

test("the report names every case with the command and exit that decided it", () => {
	const text = renderVerifyReport(buildReport([pass("c1"), fail("c2")]));
	assert.match(text, /✓ c1 PASS/);
	assert.match(text, /✗ c2 FAIL/);
	assert.match(text, /\$ node -e "run\(\)" → exit 1/);
	assert.match(text, /not verified — 1 failing, 0 unproven of 2/);
});

test("the verifier prompt forbids the test suite and demands UNVERIFIED over a guess", () => {
	const p = buildFanOutPrompt({ mode: "verify", subtasks: [], goal: "g" }, { id: "v1", instruction: "check it" }, 1);
	assert.match(p, /do not run the test suite/);
	assert.match(p, /git diff/);
	assert.match(p, /VERDICT: UNVERIFIED/);
	assert.match(p, /run NOTHING else/);
	assert.match(p, /a green suite is not proof/);
});
