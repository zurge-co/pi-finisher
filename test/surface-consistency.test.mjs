import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_COMMANDS, RETIRED_TOOLS, SURFACE_COMMANDS, SURFACE_TOOLS, isLiveTool, isRetiredTool } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const commandsSrc = () => readFileSync(join(here, "extensions/finisher/src/commands.ts"), "utf8");

test("every command in the surface has a branch, and every branch is in the surface", () => {
	const src = commandsSrc();
	for (const cmd of SURFACE_COMMANDS) {
		assert.ok(src.includes(`sub === "${cmd}"`), `SURFACE_COMMANDS advertises "${cmd}" with no handler`);
	}
	const branches = [...src.matchAll(/sub === "([a-z-]+)"/g)].map((m) => m[1]);
	for (const b of new Set(branches)) {
		assert.ok((SURFACE_COMMANDS).includes(b), `branch "${b}" is reachable but not advertised`);
	}
});

test("the description and completions are generated from the same list, so they cannot drift", () => {
	const src = commandsSrc();
	assert.ok(src.includes("[...SURFACE_COMMANDS]"), "completions must come from SURFACE_COMMANDS");
	const at = src.indexOf("description:");
	const desc = src.slice(at, src.indexOf("getArgumentCompletions"));
	assert.match(desc, /SURFACE_COMMANDS/, "the description is rendered from the one list, so a name cannot be advertised without a branch");
	for (const dead of ["approve", "gate", "memory", "ext-config", "discard", "surface"]) assert.ok(!desc.includes(dead), `the description still advertises the removed "${dead}"`);
	assert.deepEqual([...SURFACE_COMMANDS], ["models", "gaps"], "the model ladder and the extra-lap journal are the only commands");
});

test("the removed surfaces cannot come back: no memory, no gate, no ext-config machinery", () => {
	const src = commandsSrc();
	assert.ok(!src.includes("memory.jsonl"));
	assert.ok(!src.includes("ext-config"));
	const kit = readFileSync(join(here, "extensions/finisher/src/kit.ts"), "utf8");
	assert.ok(!kit.includes("learn"), "no lessons channel");
	assert.ok(!kit.includes("extConfigDialog"));
	const types = readFileSync(join(here, "extensions/finisher/src/types.ts"), "utf8");
	assert.ok(!types.includes("gateEnabled"));
	const cfg = readFileSync(join(here, "extensions/finisher/src/subagent-config.ts"), "utf8");
	assert.ok(!cfg.includes("subagentExtIncludes"), "the include list had no effect once bare boot was gone");
	assert.ok(!cfg.includes("findProviderExtension"), "the auto-heal path only existed for bare boot");
});

test("retired names stay retired and never overlap the live surface", () => {
	for (const c of ["approve", "gate", "longrun", "memory", "ext-config-show", "distill", "resume"]) assert.ok(RETIRED_COMMANDS.includes(c), `${c} must be retired`);
	assert.deepEqual(SURFACE_COMMANDS.filter((c) => RETIRED_COMMANDS.includes(c)), [], "a name cannot be both live and retired");
	for (const t of SURFACE_TOOLS) assert.equal(isLiveTool(t), true);
	for (const t of RETIRED_TOOLS) assert.equal(isRetiredTool(t), true);
	assert.deepEqual(RETIRED_TOOLS.filter((t) => isLiveTool(t)), [], "a retired tool can never be callable again");
});

test("no tool can ask a human: the ask surface is retired and the decision rule replaces it", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	const askTool = RETIRED_TOOLS.find((t) => t.endsWith("ask"));
	assert.ok(askTool, "the human picker must be listed as retired");
	for (const t of RETIRED_TOOLS) assert.ok(!tools.includes(`name: "${t}"`), `${t} must not be registered`);
	assert.equal(isLiveTool(askTool), false);
	assert.equal(isRetiredTool(askTool), true);
	const decisions = readFileSync(join(here, "extensions/finisher/src/decisions.ts"), "utf8");
	assert.match(decisions, /DECISION NEEDED/);
	assert.match(decisions, /Never stop to wait for an answer/);
});
