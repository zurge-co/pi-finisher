import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	SUBAGENT_ROLES,
	SUBAGENT_EXCLUDE_TOOLS,
	SUBAGENT_STRIP_FLAGS,
	SUBAGENT_TIMEOUT_MS,
	isSubagentRole,
	buildRpcSubagentArgs,
	FINISHER_TOOL_GLOB,
	HARNESS_TOOLS,
	ignoredModelKeys,
	readLadderSlots,
	resolveSubagentModel,
	writeLadderSlot,
} from "../extensions/finisher/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repo = (cfg) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-ladder-"));
	mkdirSync(join(dir, ".finisher"), { recursive: true });
	if (cfg !== undefined) writeFileSync(join(dir, ".finisher", "models.json"), JSON.stringify(cfg));
	return dir;
};

const here = new URL("..", import.meta.url).pathname;

test("there is exactly one role left — coders — and every table agrees on it", () => {
	assert.deepEqual([...SUBAGENT_ROLES], ["swarm"], "explore and verify are main's own work, so only coders are spawned");
	for (const role of SUBAGENT_ROLES) {
		assert.ok(role in SUBAGENT_EXCLUDE_TOOLS, `${role} must declare its tool exclusions`);
		assert.ok(role in SUBAGENT_STRIP_FLAGS, `${role} must declare its boot flags`);
		assert.ok(role in SUBAGENT_TIMEOUT_MS, `${role} must declare a timeout`);
	}
	assert.deepEqual(Object.keys(SUBAGENT_EXCLUDE_TOOLS).sort(), [...SUBAGENT_ROLES].sort(), "no extra role may hide in the tool table");
	assert.deepEqual(Object.keys(SUBAGENT_TIMEOUT_MS).filter((k) => k !== "default").sort(), [...SUBAGENT_ROLES].sort());
	assert.equal(isSubagentRole("grader"), false, "the merged role is gone");
	assert.equal(isSubagentRole("reviewer"), false);
	assert.equal(isSubagentRole("distiller"), false);
	assert.equal(isSubagentRole("verifier"), false, "the verifier role is gone: main verifies, no child is spawned to judge");
	assert.equal(isSubagentRole("swarm"), true, "coders are the only role left");
});

test("a coder cannot re-enter the harness — every finisher tool is excluded by name, and no verifier exception is left", () => {
	const args = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.swarm, "swarm");
	const excluded = args[args.indexOf("--exclude-tools") + 1].split(",");
	for (const harness of HARNESS_TOOLS) assert.ok(excluded.includes(harness), `${harness} must be excluded, or a coder could spawn coders or verify itself`);
	assert.ok(!excluded.includes("bash"), "a coder must run commands — that is how it works");
	assert.ok(!excluded.includes("write") && !excluded.includes("edit"), "a coder writes, or it cannot do its job");
	assert.equal(excluded.includes("finisher_verdict"), false, "there is no verdict tool any more: verification is main's job");
});

test("the coder CAN write, because code mode works by editing files in its own worktree", () => {
	const excluded = (SUBAGENT_EXCLUDE_TOOLS.swarm ?? []).filter((t) => t !== FINISHER_TOOL_GLOB);
	assert.ok(!excluded.includes("write"), "a coder that cannot write cannot do its job");
	assert.ok(!excluded.includes("edit"));
	const args = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.swarm, "swarm");
	const list = args[args.indexOf("--exclude-tools") + 1].split(",");
	assert.deepEqual(list.slice(0, HARNESS_TOOLS.length), [...HARNESS_TOOLS], "the harness tools are the exclusions, and nothing else");
	assert.equal(list.length, HARNESS_TOOLS.length, "a coder gets exactly the harness tools as its exclusions, and nothing else");
});

test("a coder keeps its provider extension — a bare boot made the child unable to reach any extension-provided model", () => {
	assert.ok(!SUBAGENT_STRIP_FLAGS.swarm.includes("--no-extensions"), "a coder needs the provider extension to reach its model");
	assert.ok(SUBAGENT_TIMEOUT_MS.swarm >= 300_000, "a coder runs real work, so it needs real time");
});

test("every role boots with the harness env guard, so a sub-agent never loads this extension again", () => {
	const rpcSrc = readFileSync(join(here, "extensions/finisher/src/subagent-rpc.ts"), "utf8");
	assert.match(rpcSrc, /PI_FINISHER_SUBAGENT/, "the rpc runner must set the guard env var");
	const indexSrc = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	assert.match(indexSrc, /process\.env\.PI_FINISHER_SUBAGENT === "1"/, "the entry point must honour that guard");
});

test("no role persists nothing: sub-agents keep their own session so a run can be looked at later", () => {
	const cfgSrc = readFileSync(join(here, "extensions/finisher/src/subagent-config.ts"), "utf8");
	assert.ok(!/--no-session/.test(cfgSrc), "a sub-agent without a session cannot be resumed after the fact");
	const rpcSrc = readFileSync(join(here, "extensions/finisher/src/subagent-rpc.ts"), "utf8");
	assert.match(rpcSrc, /sessionId/, "the runner must record the session it used");
});

test("a per-role key can never pick a model any more: the ladder is the only source", () => {
	const dir = repo({ swarm: "b/two", verifier: "e/five", grader: "c/three", distiller: "d/four" });
	assert.equal(resolveSubagentModel(dir).pattern, undefined, "a leftover role key must not become a sub-agent model");
	assert.equal(resolveSubagentModel(dir, { mainModel: "main/one" }).source, "main");
	assert.deepEqual(ignoredModelKeys(dir).sort(), ["distiller", "grader", "swarm", "verifier"], "every leftover role key is reported as ignored, including the verifier one that no longer exists");
});

test("the ladder is a priority order: the first set rung wins, later rungs only exist for failover", () => {
	assert.equal(resolveSubagentModel(repo({ priority1: "a/one", priority2: "b/two" })).pattern, "a/one");
	assert.equal(resolveSubagentModel(repo({ priority1: "a/one", priority2: "b/two" })).source, "priority");
	assert.equal(resolveSubagentModel(repo({ priority2: "b/two" })).pattern, "b/two", "a gap at rung 1 skips to the rung that is set");
	assert.equal(resolveSubagentModel(repo({}), { slotModel: "slot/x", mainModel: "main/one" }).pattern, "slot/x", "an explicit slot model outranks the ladder");
	assert.equal(resolveSubagentModel(repo({}), { slotModel: "slot/x" }).source, "slot");
	assert.equal(resolveSubagentModel(repo({})).source, "none", "an empty config with no main model resolves to nothing, not a guess");
});

test("/finisher models writes ladder keys, never a role key, and clearing one removes only that rung", () => {
	const dir = repo({ swarm: "b/two" });
	writeLadderSlot(dir, "priority1", "a/one");
	writeLadderSlot(dir, "priority2", "b/two");
	assert.deepEqual(readLadderSlots(dir).filter((s) => s.pattern).map((s) => s.pattern), ["a/one", "b/two"]);
	writeLadderSlot(dir, "priority2", null);
	assert.deepEqual(readLadderSlots(dir).filter((s) => s.pattern).map((s) => s.pattern), ["a/one"], "the ladder always shows all five rungs, so the cleared one is an empty rung");
	const raw = JSON.parse(readFileSync(join(dir, ".finisher", "models.json"), "utf8"));
	assert.equal(raw.priority1, "a/one");
	assert.ok(!("priority2" in raw), "a cleared rung is removed, not written as empty");
	assert.equal(raw.swarm, "b/two", "an ignored key is left alone rather than silently rewritten");
});

test("the rung picker is never empty: every config shape still offers all five rungs", () => {
	for (const cfg of [undefined, {}, { swarm: "b/two" }, { priority: [] }, { priority: ["a/one"] }, { priority1: "a/one" }, "{ not json"]) {
		const dir = repo(undefined);
		if (cfg !== undefined) writeFileSync(join(dir, ".finisher", "models.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
		assert.deepEqual(readLadderSlots(dir).map((s) => s.key), ["priority1", "priority2", "priority3", "priority4", "priority5"], `config ${JSON.stringify(cfg)} must still offer every rung`);
	}
});

test("a legacy priority array is read and migrated on the next write, so no rung is lost", () => {
	const dir = repo({ priority: ["a/one", "b/two"] });
	assert.deepEqual(readLadderSlots(dir).filter((s) => s.pattern).map((s) => s.pattern), ["a/one", "b/two"]);
	assert.equal(resolveSubagentModel(dir).pattern, "a/one");
	writeLadderSlot(dir, "priority3", "c/three");
	const raw = JSON.parse(readFileSync(join(dir, ".finisher", "models.json"), "utf8"));
	assert.ok(!("priority" in raw), "the old array is folded into rungs");
	assert.deepEqual(readLadderSlots(dir).filter((s) => s.pattern).map((s) => s.pattern), ["a/one", "b/two", "c/three"]);
});

test("the model-facing surface offers steering, so the main agent can act on another worker's finding", () => {
	const toolsSrc = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(toolsSrc, /name: "finisher_steer"/);
	assert.match(toolsSrc, /steerLive/, "it must reach the live registry");
	assert.match(toolsSrc, /followUpLive/);
});

test("no role's boot flags can strip extensions — that is what broke provider resolution", () => {
	for (const role of SUBAGENT_ROLES) {
		const argv = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS[role], role);
		assert.ok(!argv.includes("--no-extensions"), `${role} must keep extension loading, or its model may be unreachable`);
		assert.ok(!SUBAGENT_STRIP_FLAGS[role].includes("--no-extensions"), `${role}: the base flags never force a bare boot`);
	}
});

test("finisher_swarm refuses explore and verify, naming where each of those jobs went", async () => {
	const { registerTools } = await import("../extensions/finisher/src/tools.ts");
	const { createStateBox } = await import("../extensions/finisher/index.ts");
	const cwd = repo({ priority1: "stub/one" });
	const state = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const defs = [];
	const launched = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return state.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "ran coders" }], details: {} }),
		armGoalRound: () => {},
		launchSubagent: async (_ctx, role, task) => {
			launched.push({ role, task });
			return { ok: true, output: "done", logPath: `/tmp/${role}.log` };
		},
	});
	const swarm = defs.find((d) => d.name === "finisher_swarm");
	const ctx = { cwd, model: { provider: "p", id: "m" }, hasUI: false, ui: { notify: () => {} } };
	for (const mode of ["explore", "verify"]) {
		const out = await swarm.execute(`call-${mode}`, { mode, goal: "g", subtasks: [{ id: "s1", instruction: "x" }] }, undefined, undefined, ctx);
		assert.equal(out.isError, true, `mode=${mode} must be refused`);
		assert.match(out.content[0].text, /finisher_verify/, `mode=${mode} must point at the tool that does that job now`);
		assert.match(out.content[0].text, new RegExp(mode), "it must name the mode it refused");
	}
	assert.deepEqual(launched, [], "a refused mode spawns nothing — no verifier, no reader");
	const code = await swarm.execute("call-code", { subtasks: [{ id: "s1", instruction: "write it", files: ["src/a.ts"] }] }, undefined, undefined, ctx);
	assert.equal(code.isError, undefined, "code is still accepted without naming the mode");
	assert.match(code.content[0].text, /ran coders/);
});
