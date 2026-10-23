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
	orphanRoleKeys,
	modelForRole,
	ZENSE_TOOL_GLOB,
} from "../extensions/zense-harness/index.ts";

const here = new URL("..", import.meta.url).pathname;

test("there are exactly two roles, and every table agrees on them", () => {
	assert.deepEqual([...SUBAGENT_ROLES], ["swarm", "verifier"], "only the workflow roles exist");
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
	assert.equal(isSubagentRole("verifier"), true);
});

test("the verifier can run commands to prove things but can never write a file", () => {
	const args = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.verifier, "verifier");
	const excluded = args[args.indexOf("--exclude-tools") + 1].split(",");
	assert.ok(excluded.includes("write"), "a verifier must not write");
	assert.ok(excluded.includes("edit"), "a verifier must not edit");
	assert.ok(!excluded.includes("bash"), "a verifier MUST be able to run commands — evidence is the whole point");
	assert.equal(excluded[0], ZENSE_TOOL_GLOB, "it also cannot re-enter the harness");
});

test("the coder CAN write, because code mode works by editing files in its own worktree", () => {
	const excluded = (SUBAGENT_EXCLUDE_TOOLS.swarm ?? []).filter((t) => t !== ZENSE_TOOL_GLOB);
	assert.ok(!excluded.includes("write"), "a coder that cannot write cannot do its job");
	assert.ok(!excluded.includes("edit"));
	const args = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.swarm, "swarm");
	assert.equal(args[args.indexOf("--exclude-tools") + 1], ZENSE_TOOL_GLOB, "the harness glob is still the only exclusion");
});

test("both roles keep their provider extension — a bare boot made the verifier unable to reach any extension-provided model", () => {
	assert.ok(!SUBAGENT_STRIP_FLAGS.verifier.includes("--no-extensions"), "a verifier must still reach its model (verified: bare boot gave 'Unknown provider')");
	assert.ok(!SUBAGENT_STRIP_FLAGS.swarm.includes("--no-extensions"), "a coder needs the provider extension to reach its model");
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.verifier, SUBAGENT_STRIP_FLAGS.swarm, "the two roles boot the same way; they differ only in tool rights");
	assert.ok(SUBAGENT_TIMEOUT_MS.verifier >= 300_000, "a verifier runs real commands, so it needs real time");
});

test("every role boots with the harness env guard, so a sub-agent never loads this extension again", () => {
	const rpcSrc = readFileSync(join(here, "extensions/zense-harness/src/subagent-rpc.ts"), "utf8");
	assert.match(rpcSrc, /PI_ZENSE_SUBAGENT/, "the rpc runner must set the guard env var");
	const indexSrc = readFileSync(join(here, "extensions/zense-harness/index.ts"), "utf8");
	assert.match(indexSrc, /process\.env\.PI_ZENSE_SUBAGENT === "1"/, "the entry point must honour that guard");
});

test("no role persists nothing: sub-agents keep their own session so a run can be looked at later", () => {
	const cfgSrc = readFileSync(join(here, "extensions/zense-harness/src/subagent-config.ts"), "utf8");
	assert.ok(!/--no-session/.test(cfgSrc), "a sub-agent without a session cannot be resumed after the fact");
	const rpcSrc = readFileSync(join(here, "extensions/zense-harness/src/subagent-rpc.ts"), "utf8");
	assert.match(rpcSrc, /sessionId/, "the runner must record the session it used");
});

test("a stale key in models.json is reported as an orphan, never silently applied to a role", () => {
	const cfg = { priority1: "a/one", swarm: "b/two", grader: "c/three", distiller: "d/four", verifier: "e/five" };
	assert.deepEqual(orphanRoleKeys(cfg, SUBAGENT_ROLES), ["grader", "distiller"], "the dead roles are named, the ladder key is not");
	assert.equal(modelForRole(cfg, "swarm"), "b/two");
	assert.equal(modelForRole(cfg, "verifier"), "e/five");
	assert.equal(modelForRole(cfg, "grader"), undefined, "a dead role never resolves to a model");
	assert.equal(modelForRole({ swarm: "   " }, "swarm"), undefined, "a blank value is not a model");
});

test("the model-facing surface offers steering, so the main agent can act on another worker's finding", () => {
	const toolsSrc = readFileSync(join(here, "extensions/zense-harness/src/tools.ts"), "utf8");
	assert.match(toolsSrc, /name: "zense_steer"/);
	assert.match(toolsSrc, /steerLive/, "it must reach the live registry");
	assert.match(toolsSrc, /followUpLive/);
});

test("no resolved boot for any role can strip extensions — that is what broke provider resolution", async () => {
	const { subagentStripFlagsAsync } = await import("../extensions/zense-harness/index.ts");
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "zense-boot-"));
	const other = mkdtempSync(join(tmpdir(), "zense-boot-g-"));
	for (const role of SUBAGENT_ROLES) {
		const flags = await subagentStripFlagsAsync(role, dir, undefined, dir, other);
		assert.ok(!flags.includes("--no-extensions"), `${role} must keep extension loading, or its model may be unreachable`);
		assert.deepEqual(flags, SUBAGENT_STRIP_FLAGS[role], `${role}: with no opt-ins the resolved flags are exactly the base flags`);
		const argv = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS[role], role, flags);
		assert.ok(!argv.includes("--no-extensions"), `${role}: the final argv must not strip extensions either`);
	}
});
