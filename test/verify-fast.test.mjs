import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFanOutPrompt, decisiveAnswer, runSwarm, SUBAGENT_ROLES, SUBAGENT_STRIP_FLAGS } from "../extensions/finisher/index.ts";

const slots = [1, 2, 3, 4].map((p) => ({ id: `slot${p}`, priority: p, model: `m/${p}` }));
const VERDICT_FAIL = "$ node -e run()\nexit code 1\nVERDICT: FAIL — the bound breaks at 3";
const TRANSPORT = "spawn ENOENT: the model was unreachable";
const VERDICT_PASS = "$ node -e run()\nexit code 0\nVERDICT: PASS";

test("a declared verdict is a decisive answer; a transport failure is not", () => {
	assert.equal(decisiveAnswer(VERDICT_FAIL), true);
	assert.equal(decisiveAnswer("$ node -e run()\nexit code 0\nVERDICT: UNVERIFIED — needs a browser"), true);
	assert.equal(decisiveAnswer(VERDICT_PASS), false, "PASS is ok:true in practice, so it is never a stop signal here");
	assert.equal(decisiveAnswer(TRANSPORT), false);
	assert.equal(decisiveAnswer(""), false);
});

test("verify spends one attempt on a decisive answer and the full bound on a transport failure — for every bound", async () => {
	for (let maxAttempts = 1; maxAttempts <= 4; maxAttempts++) {
		const spend = async (output, stopOnDeclaredAnswer) => {
			const [r] = await runSwarm([{ id: "c1" }], { slots, maxAttempts, stopOnDeclaredAnswer, run: async () => ({ ok: false, output }) });
			return r.attempts;
		};
		assert.equal(await spend(VERDICT_FAIL, true), 1, `maxAttempts=${maxAttempts}: a judged FAIL must not buy a second model run`);
		assert.equal(await spend(TRANSPORT, true), maxAttempts, `maxAttempts=${maxAttempts}: a transport failure still fails over`);
		assert.equal(await spend(VERDICT_FAIL, false), maxAttempts, `maxAttempts=${maxAttempts}: explore/code keep the old retry behaviour`);
	}
});

test("a decisive answer still reports the failure it declared, with the model that answered", async () => {
	const [r] = await runSwarm([{ id: "c1" }], { slots, maxAttempts: 4, stopOnDeclaredAnswer: true, run: async (_t, s) => ({ ok: false, output: `${VERDICT_FAIL} [${s.model}]` }) });
	assert.equal(r.ok, false);
	assert.equal(r.attempts, 1);
	assert.match(r.output, /VERDICT: FAIL/);
	assert.equal(r.failures.length, 1);
});

test("sub-agents boot without MCP servers and without skills — both roles", () => {
	for (const role of SUBAGENT_ROLES) {
		assert.ok(SUBAGENT_STRIP_FLAGS[role].includes("--no-mcp"), `${role} must not connect MCP servers to answer a question`);
		assert.ok(SUBAGENT_STRIP_FLAGS[role].includes("--no-skills"), `${role} must not load skill files for a slice prompt`);
	}
});

test("the verifier prompt is a fixed short scaffold: every line it adds is bounded, for any goal and any instruction", () => {
	const scaffold = (goal, instruction, attempt = 1) => buildFanOutPrompt({ mode: "verify", subtasks: [], goal }, { id: "v1", instruction }, attempt);
	const fixed = scaffold("", "").length;
	assert.ok(fixed <= 950, `the fixed scaffold alone is ${fixed} chars — it must stay short`);
	for (const goal of ["g", "prove the bound holds for every input", "x".repeat(400)]) {
		for (const attempt of [1, 2, 9]) {
			const p = scaffold(goal, "exercise the bound", attempt);
			assert.ok(p.length <= fixed + goal.length + 40 + (attempt > 1 ? 90 : 0), `prompt grew by more than the goal it echoes: ${p.length} vs ${fixed}+${goal.length}`);
			for (const phrase of ["do not run the test suite", "git diff", "VERDICT: UNVERIFIED", "run NOTHING else", "a green suite is not proof", "smallest command"])
				assert.match(p, new RegExp(phrase), `${phrase} must be unconditional, not trading off against length`);
		}
	}
});
