import { test } from "node:test";
import assert from "node:assert/strict";

const evidence = (body) => (String(body).trim() ? `EVIDENCE:\n${body}` : "");
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFanOutPrompt } from "../extensions/finisher/index.ts";
import { freshGoalRun, nextGoalDriverStep } from "../extensions/finisher/index.ts";
import {
	buildHumanTestNote,
	buildReplanPrompt,
	buildReport,
	decideOnce,
	freshAttempts,
	judgeCase,
	MAX_LOOP_BATCHES,
	renderVerifyReport,
	recordEvidence,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const pass = (id) => judgeCase(id, evidence(`$ node -e "run()"\nexit code 0\nVERDICT: PASS`));
const fail = (id) => judgeCase(id, evidence(`$ node -e "run()"\nexit code 1\nVERDICT: FAIL`));
const unverified = (id) => judgeCase(id, evidence("VERDICT: UNVERIFIED — needs a browser"));

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
	const c = judgeCase("c1", evidence(`$ curl localhost:1\nexit code 0\nVERDICT: UNVERIFIED — it needs a browser`));
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

test("identical evidence halts instead of spending another round — the fingerprint is what the loop actually reads", () => {
	const same = buildReport([fail("c1")]);
	const once = decideOnce(same, recordEvidence(freshAttempts(), buildReport([fail("c1")])));
	assert.equal(once.kind, "replan", "the first failing round is still worth one plan");
	const twice = decideOnce(same, recordEvidence({ ...freshAttempts(), rounds: 1 }, buildReport([fail("c1")])));
	assert.equal(twice.kind, "halt");
	assert.match(twice.reason, /identical evidence/);
	const moved = decideOnce(buildReport([fail("c2")]), recordEvidence({ ...freshAttempts(), rounds: 1 }, same));
	assert.equal(moved.kind, "replan", "different evidence is progress, so it still replans");
	const firstEver = decideOnce(same, freshAttempts());
	assert.equal(firstEver.kind, "replan", "with no previous round there is nothing to compare, so it must not halt");
});

test("the driver records the evidence it judged, so the next round can compare against it", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([fail("c1")]));
	assert.equal(step.action, "replan");
	assert.equal(typeof step.state.attempts.lastFingerprint, "string", "a round with no fingerprint can never detect a repeat");
	const again = nextGoalDriverStep(step.state, buildReport([fail("c1")]));
	assert.equal(again.action, "halt", "the second identical round stops instead of looping");
});

test("a verifier that never ran is BLOCKED, never a FAIL and never a quiet UNVERIFIED", () => {
	for (const infra of [
		"sub-agent rpc error: Unknown provider synthetic2",
		"TIMEOUT 600s\nlast output:\n`npm test`\nexit 0",
		"cancelled by user (Esc)",
		"the sub-agent never came up",
		"spawn ENOENT",
		"no model to run",
		"",
	]) {
		const c = judgeCase("c1", evidence(infra), { exitCode: 1 });
		assert.equal(c.verdict, "BLOCKED", `infra output must not be judged as work: ${infra.slice(0, 40)}`);
		assert.match(c.reason ?? "", /never produced a verdict/);
		assert.deepEqual(buildReport([c]).failed, [], "a broken verifier is not a failing case");
		assert.deepEqual(buildReport([c]).blocked, ["c1"]);
	}
	const real = judgeCase("c1", evidence("`npm test`\nexit 0\nVERDICT: PASS"));
	assert.equal(real.verdict, "PASS", "a real verdict is never swallowed by the infra check");
	assert.equal(judgeCase("c1", "I looked at the diff and it seems fine").verdict, "UNVERIFIED", "a bare claim is still UNVERIFIED, not BLOCKED");
});

test("a broken verifier stops the loop and goes to the human instead of spending more rounds", () => {
	const blocked = judgeCase("c1", evidence("sub-agent rpc error: Unknown provider x"), { exitCode: 1 });
	const d = decideOnce(buildReport([blocked]), freshAttempts());
	assert.equal(d.kind, "human", "an unrunnable verifier can never justify a replan");
	const mixed = decideOnce(buildReport([judgeCase("c1", evidence("`node x`\nexit 1\nVERDICT: FAIL")), blocked]), freshAttempts());
	assert.equal(mixed.kind, "human", "even with a real failure present, a blocked case needs the human");
	assert.match(mixed.reason, /broken verifier is not evidence/);
	assert.equal(decideOnce(buildReport([blocked]), { rounds: 9 }).kind, "human", "the round bound cannot turn it into a halt-without-human");
});

test("a partial round tells the human what is untestable AND what still fails, instead of replanning silently", () => {
	const step = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([judgeCase("c1", evidence("`node x`\nexit 1\nVERDICT: FAIL")), judgeCase("c2", evidence("VERDICT: UNVERIFIED — needs a real terminal"))]));
	assert.equal(step.action, "replan", "the failing case is still worth fixing");
	assert.match(step.text, /needs a human/, "but the human is told about the untestable case in the same breath");
	assert.match(step.text, /c2/);
	assert.match(step.text, /also still fail \(c1\)/, "the human is not told it is fixed when it is not");
	assert.match(step.text, /what was actually proven: 0 of 2/);
	assert.match(step.text, /do not invent a way to prove c2/);
	const clean = nextGoalDriverStep(freshGoalRun("ship it"), buildReport([judgeCase("c1", evidence("`node x`\nexit 1\nVERDICT: FAIL"))]));
	assert.doesNotMatch(clean.text, /needs a human/, "a plain failure stays a plain failure — no noise");
});

test("the report counts blocked cases as unproven, never as failing", () => {
	const text = renderVerifyReport(buildReport([judgeCase("c1", evidence("`node x`\nexit 0\nVERDICT: PASS")), judgeCase("c2", evidence("sub-agent rpc error: boom"), { exitCode: 1 })]));
	assert.match(text, /✓ c1 PASS/);
	assert.match(text, /⊘ c2 BLOCKED/);
	assert.match(text, /0 failing, 1 unproven of 2/);
});
