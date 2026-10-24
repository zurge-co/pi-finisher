import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APPLY_BACK_COMMANDS,
	RETIRED_COMMANDS,
	RETIRED_TOOLS,
	SURFACE_COMMANDS,
	SURFACE_TOOLS,
	costCeilingKeysPresent,
	isLiveTool,
	isRetiredTool,
	readConfigSurface,
	surfaceLine,
} from "../extensions/finisher/index.ts";

const repo = (models, config) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-surface-"));
	mkdirSync(join(dir, ".finisher"), { recursive: true });
	if (models !== undefined) writeFileSync(join(dir, ".finisher", "models.json"), JSON.stringify(models));
	if (config !== undefined) writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify(config));
	return dir;
};

test("the agent-facing surface is the goal tools — nothing that asks a human", () => {
	assert.deepEqual([...SURFACE_TOOLS], ["finisher_goal", "finisher_phase", "finisher_swarm", "finisher_steer"]);
	for (const t of RETIRED_TOOLS) {
		assert.equal(isRetiredTool(t), true, `${t} must be retired`);
		assert.equal(isLiveTool(t), false, `${t} must not be callable`);
	}
	for (const t of SURFACE_TOOLS) assert.equal(isLiveTool(t), true);
	assert.equal(isRetiredTool("bash"), false);
	assert.equal(isLiveTool("bash"), false);
	const overlap = SURFACE_COMMANDS.filter((c) => RETIRED_COMMANDS.includes(c));
	assert.deepEqual(overlap, [], "no command may be both live and retired");
	for (const c of ["approve", "gate", "longrun"]) assert.ok(RETIRED_COMMANDS.includes(c));
	for (const c of APPLY_BACK_COMMANDS) {
		assert.ok(SURFACE_COMMANDS.includes(c), `${c} still exists in the browser, so it must be declared live`);
		assert.equal(RETIRED_COMMANDS.includes(c), false, `${c} is not retired`);
	}
});

test("config keeps only what the goal path needs and reports cost keys instead of honouring them", () => {
	const dir = repo({ priority: ["a/one", "b/two", "a/one", 42, " ", "c/three", "d/four", "e/five", "f/six"] }, { swarmConcurrency: 3, maxTokens: 1000, subagentTimeoutMs: { default: 1000 } });
	const cfg = readConfigSurface(dir);
	assert.deepEqual(cfg.priority, ["a/one", "b/two", "c/three", "d/four", "e/five"]);
	assert.equal(cfg.swarmConcurrency, 3);
	assert.deepEqual(cfg.subagentTimeoutMs, { default: 1000 });
	assert.deepEqual(cfg.ignoredKeys, ["maxTokens"]);
	assert.deepEqual(costCeilingKeysPresent(dir), ["maxTokens"]);
	assert.match(surfaceLine(dir), /token\/cost ceiling: none \(ignored keys: maxTokens\)/);
});

test("a missing or broken config degrades to the plain surface instead of throwing", () => {
	const empty = repo(undefined, undefined);
	assert.deepEqual(readConfigSurface(empty), { priority: [], ignoredKeys: [] });
	assert.match(surfaceLine(empty), /model ladder: \(main session model only\)/);
	const broken = repo(undefined, undefined);
	writeFileSync(join(broken, ".finisher", "models.json"), "{ not json");
	writeFileSync(join(broken, ".finisher", "config.json"), "[1,2,3]");
	assert.deepEqual(readConfigSurface(broken).priority, []);
	assert.deepEqual(costCeilingKeysPresent(broken), []);
	const junk = repo({ priority: ["x/y"] }, { swarmConcurrency: 0 });
	assert.equal(readConfigSurface(junk).swarmConcurrency, undefined);
});

test("the single end report names every case with the evidence that decided it", async () => {
	const { buildReport, freshGoalRun, judgeCase, nextGoalDriverStep } = await import("../extensions/finisher/index.ts");
	const cases = [judgeCase("c1", "$ npm test\nexit code 0\nVERDICT: PASS"), judgeCase("c2", "$ npx tsc --noEmit\nexit code 1\nVERDICT: FAIL"), judgeCase("c3", "looks fine to me")];
	let state = freshGoalRun("ship it");
	let step = nextGoalDriverStep(state, buildReport(cases));
	const seen = [step];
	for (let i = 0; i < 5 && step.action === "replan"; i++) {
		const evidence = cases.map((c) => (c.caseId === "c2" ? judgeCase("c2", "$ npx tsc --noEmit\nexit code 1\nVERDICT: FAIL") : c));
		step = nextGoalDriverStep(step.state, buildReport(evidence.map((c, n) => (c.verdict === "UNVERIFIED" ? judgeCase(c.caseId, `$ npm test -- --round${i}${n}\nexit code 0\nVERDICT: PASS`) : c))));
		seen.push(step);
	}
	const last = seen[seen.length - 1];
	assert.ok(["finish", "human", "halt"].includes(last.action), `the run must end, got ${last.action}`);
	for (const id of ["c1", "c2", "c3"]) assert.ok(last.text.includes(id), `the final report must mention ${id}`);
	assert.match(last.text, /exit 1/, "the failing case keeps its exit status in the report");
});

test("no code path can stop a run for cost: the only bounds are evidence and rounds", async () => {
	const { MAX_LOOP_BATCHES, freshGoalRun, judgeCase, buildReport, nextGoalDriverStep } = await import("../extensions/finisher/index.ts");
	const driverSrc = await import("node:fs").then((fs) => fs.readFileSync(new URL("../extensions/finisher/src/goal-driver.ts", import.meta.url), "utf8"));
	assert.doesNotMatch(driverSrc, /maxTokens|costLimit|budget|tokenCeiling|maxCost/i, "the driver must not read a cost budget");
	assert.doesNotMatch(driverSrc, /tokensUsed|tokensUsed\s*[<>]/, "the driver must not gate on tokens used");
	const healthy = Array.from({ length: MAX_LOOP_BATCHES + 1 }, (_, i) => judgeCase("c1", `$ npm test -- --r${i}\nexit code 1\nVERDICT: FAIL`));
	let state = freshGoalRun("expensive goal");
	const actions = healthy.map((c) => {
		const step = nextGoalDriverStep(state, buildReport([c]));
		state = step.state;
		return step.action;
	});
	assert.deepEqual(actions.slice(0, -1).every((a) => a === "replan"), true, "failing attempts ask the main agent to plan another loop, regardless of cost");
	assert.equal(actions[actions.length - 1], "halt", "the halt is the attempt bound, not a budget");
});

test("every command the surface advertises has a real handler — no ghost commands after a subsystem is removed", async () => {
	const { readFileSync } = await import("node:fs");
	const here = new URL("..", import.meta.url).pathname;
	const src = readFileSync(join(here, "extensions/finisher/src/commands.ts"), "utf8");
	for (const cmd of SURFACE_COMMANDS) {
		assert.ok(src.includes(`sub === "${cmd}"`), `SURFACE_COMMANDS advertises "${cmd}" but commands.ts has no branch for it`);
	}
	assert.ok(!SURFACE_COMMANDS.includes("distill"), "the distiller role is gone, so /finisher distill must not be advertised");
	assert.ok(!/sub === "distill"/.test(src), "and no orphan branch may linger");
	assert.ok(!src.includes("runDistill"));
});
