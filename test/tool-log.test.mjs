import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeToolEvent, encodeToolEvent, isToolLogLine, outputLines, parseLogItems, renderLogItems, toolHeadline, toolTarget, TOOL_OUTPUT_MAX_LINES } from "../extensions/finisher/index.ts";
import { toolEventFrom } from "../extensions/finisher/index.ts";
import { sessionBody, sessionKeyLine } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const start = (id, name, args) => encodeToolEvent({ phase: "start", id, name, args });
const end = (id, name, output, isError = false) => encodeToolEvent({ phase: "end", id, name, output, isError, durationMs: 1200 });
const run = (extra = {}) => ({ role: "verifier", at: 1, startedAt: 1, status: "running", prompt: "prove the bound", ...extra });

test("the page shows the full command, never just the tool name", () => {
	assert.equal(toolTarget("bash", { command: "npm test -- swarm-scheduler" }), "npm test -- swarm-scheduler");
	assert.equal(toolTarget("read", { path: "extensions/finisher/src/swarm.ts" }), "extensions/finisher/src/swarm.ts");
	assert.equal(toolTarget("grep", { pattern: "armGoalRound" }), "armGoalRound");
	assert.match(toolHeadline({ name: "bash", target: "npm test -- swarm-scheduler", state: "ok", durationMs: 1200 }), /✓ bash — npm test -- swarm-scheduler 1\.2s/);
	assert.match(toolHeadline({ name: "bash", target: "npm test", state: "error" }), /^✗ bash/);
	assert.match(toolHeadline({ name: "bash", target: "npm test", state: "running" }), /^⚙ bash/);
	assert.equal(toolHeadline({ name: "bash", target: "x".repeat(400) }).length <= 111, true, "a huge command cannot blow the row budget");
	assert.doesNotMatch(toolHeadline({ name: "bash", target: "a\nb\tc", state: "ok" }), /[\n\t]/, "a multi-line command is flattened onto one row");
});

test("every tool call in the log is visible, and a fold hides the output while keeping the command", () => {
	const lines = [start("c1", "bash", { command: "node --test a.test.mjs" }), "some prose", end("c1", "bash", "5 tests pass"), start("c2", "read", { path: "src/swarm.ts" }), end("c2", "read", "export const x = 1;")];
	const items = parseLogItems(lines);
	assert.equal(items.filter((i) => i.kind === "tool").length, 2, "both calls must be on the page");
	const collapsed = renderLogItems(items, { expanded: false }).join("\n");
	const expanded = renderLogItems(items, { expanded: true }).join("\n");
	for (const head of ["node --test a.test.mjs", "src/swarm.ts"]) {
		assert.ok(collapsed.includes(head), `the command is visible while folded: ${head}`);
		assert.ok(expanded.includes(head), `the command is visible while expanded: ${head}`);
	}
	assert.ok(collapsed.includes("line(s) of output hidden"), "a fold says what it is hiding");
	assert.ok(!collapsed.includes("5 tests pass"), "the fold really hides the output");
	assert.ok(expanded.includes("5 tests pass") && expanded.includes("export const x = 1;"), "expanding shows the tool output itself");
	assert.ok(collapsed.includes("some prose"), "prose around the calls is never dropped");
});

test("an end without a start is still shown, and errors are marked as errors", () => {
	const orphan = parseLogItems([end("x9", "bash", "boom", true)]);
	assert.equal(orphan.length, 1);
	assert.equal(orphan[0].block.state, "error", "a failing tool is never shown as a success");
	assert.match(renderLogItems(orphan, { expanded: true }).join("\n"), /✗ bash/);
});

test("the fold is bounded: a huge output keeps the newest lines and says how many it hid", () => {
	const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
	const kept = outputLines(many);
	assert.equal(kept.length, TOOL_OUTPUT_MAX_LINES + 1, "the hidden-count line is not part of the budget");
	assert.ok(kept[0].includes("earlier line(s) hidden"));
	assert.ok(kept.at(-1) === "line 499", "the newest output is the part that matters");
	assert.deepEqual(outputLines(undefined), []);
	assert.deepEqual(outputLines("one"), ["one"]);
});

test("a log line that only looks like a tool event is left as text, and encoding round-trips", () => {
	const ev = { phase: "start", id: "c1", name: "bash", args: { command: "ls" } };
	assert.deepEqual(decodeToolEvent(encodeToolEvent(ev)), ev);
	assert.equal(decodeToolEvent("⚙ bash"), undefined);
	assert.equal(decodeToolEvent("\u0000fin-tool:{not json"), undefined);
	assert.equal(isToolLogLine(encodeToolEvent(ev)), true);
	assert.equal(isToolLogLine("⚙ bash"), false);
});

test("the real rpc event shape is what feeds the page — args and result, not just a name", () => {
	const s = toolEventFrom({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } });
	assert.deepEqual(s, { phase: "start", id: "c1", name: "bash", args: { command: "npm test" } });
	const e = toolEventFrom({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, durationMs: 40, result: { content: [{ type: "text", text: "281 pass" }] } });
	assert.equal(e.output, "281 pass");
	assert.equal(e.durationMs, 40);
	assert.equal(toolEventFrom({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash" }).output, undefined);
});

test("the page tells the human the toggle exists, and only when there is something to toggle", () => {
	const withTools = sessionBody(run(), [start("c1", "bash", { command: "npm test" }), end("c1", "bash", "ok")], 90);
	assert.ok(withTools.join("\n").includes("t = show tool output"), "the key is advertised exactly where it is needed");
	const noTools = sessionBody(run(), ["just prose"], 90);
	assert.ok(!noTools.join("\n").includes("t = show tool output"), "no tool calls means no toggle to advertise");
	assert.match(sessionKeyLine(3, 2, false), /t = show tool output \(2\)/);
	assert.match(sessionKeyLine(3, 2, true), /t = hide tool output/);
	assert.equal(sessionKeyLine(1).includes("tool output"), false);
});

test("the viewer really wires the toggle and reads the log through the parser", () => {
	const views = readFileSync(join(here, "extensions/finisher/src/viewers.ts"), "utf8");
	assert.match(views, /expanded = !expanded/, "t must flip the fold");
	assert.match(views, /sessionBody\(run, rememberTools\(run, logs\(run\)\), width, \{ expanded \}\)/, "the fold must reach the renderer, and the log must come through the cached reader");
	assert.match(views, /createLogReader\(\)/, "one frame reads a log once, not once per widget");
	assert.match(views, /logs\.beginFrame\(\)/, "the frame boundary is what makes the cache a per-frame cache");
	assert.equal(/readFileSync/.test(views), false, "a per-frame full re-read of a log is what froze the HUD");
	assert.match(views, /state\.toolOutputExpanded/, "the choice survives reopening the page");
});
