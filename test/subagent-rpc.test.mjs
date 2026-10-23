import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRpcSubagentArgs,
	withZenseToolGlob,
	ZENSE_TOOL_GLOB,
	finalTextFromMessages,
	modelLabel,
	splitModelPattern,
	raceTimeout,
	textFromEvent,
	toolLineFromEvent,
	isSettled,
} from "../extensions/zense-harness/index.ts";

const here = new URL("..", import.meta.url).pathname;

test("every role boots with the zense tools excluded, so a sub-agent can never spawn the harness", () => {
	for (const [role, tools] of Object.entries({ swarm: [], verifier: ["write", "edit"] })) {
		const args = buildRpcSubagentArgs(tools, role);
		const at = args.indexOf("--exclude-tools");
		assert.ok(at >= 0, `${role} must exclude tools`);
		const list = args[at + 1].split(",");
		assert.equal(list[0], ZENSE_TOOL_GLOB, `${role} must exclude the harness tools first`);
		for (const t of tools) assert.ok(list.includes(t), `${role} must still exclude ${t}`);
		assert.equal(list.filter((t) => t === ZENSE_TOOL_GLOB).length, 1, `${role} must not duplicate the glob`);
	}
});

test("adding the glob is idempotent and never drops a role's own exclusions", () => {
	assert.deepEqual(withZenseToolGlob(undefined), [ZENSE_TOOL_GLOB]);
	assert.deepEqual(withZenseToolGlob([]), [ZENSE_TOOL_GLOB]);
	assert.deepEqual(withZenseToolGlob([ZENSE_TOOL_GLOB]), [ZENSE_TOOL_GLOB]);
	assert.deepEqual(withZenseToolGlob(["write", ZENSE_TOOL_GLOB, "edit"]), [ZENSE_TOOL_GLOB, "write", "edit"]);
});

test("the rpc boot keeps a session so the run can be revisited, and never a hand-rolled spawn", () => {
	const args = buildRpcSubagentArgs(["write"], "swarm");
	assert.ok(!args.includes("--no-session"), "a sub-agent keeps its own session, so it can be resumed later");
	const src = readFileSync(join(here, "extensions/zense-harness/src/subagent-rpc.ts"), "utf8");
	assert.match(src, /RpcClient/, "the runner must go through RpcClient, not a hand-rolled spawn");
	assert.ok(!/spawn\(/.test(src), "no hand-rolled process spawn is left in the rpc runner");
});

test("a model pattern splits into provider and model without eating a thinking suffix", () => {
	assert.deepEqual(splitModelPattern("synthetic/hf:openai/gpt-oss-120b"), { provider: "synthetic", model: "hf:openai/gpt-oss-120b" });
	assert.deepEqual(splitModelPattern("anthropic/claude-sonnet-4-5:high"), { provider: "anthropic", model: "claude-sonnet-4-5:high" });
	assert.deepEqual(splitModelPattern(undefined), {});
	assert.deepEqual(splitModelPattern("   "), {});
	assert.deepEqual(splitModelPattern("judge"), { model: "judge" });
});

test("the final answer is the last assistant text, not the whole stream", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "do it" }] },
		{ role: "assistant", content: [{ type: "text", text: "first try" }, { type: "tool_use" }] },
		{ role: "toolResult", content: [{ type: "text", text: "output" }] },
		{ role: "assistant", content: [{ type: "text", text: "done: " }, { type: "text", text: "the bound holds" }] },
	];
	assert.equal(finalTextFromMessages(messages), "done: the bound holds");
	assert.equal(finalTextFromMessages([]), "");
	assert.equal(finalTextFromMessages([{ role: "user", content: [] }]), "");
	assert.equal(modelLabel({ provider: "synthetic", id: "x" }), "synthetic/x");
	assert.equal(modelLabel(undefined), undefined);
});

test("stream events are read by type, and anything else is ignored instead of leaking into the output", () => {
	assert.equal(textFromEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }), "hi");
	assert.equal(textFromEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } }), "");
	assert.equal(textFromEvent({ type: "turn_start" }), "");
	assert.equal(toolLineFromEvent({ type: "tool_execution_start", toolName: "bash" }), "\n⚙ bash\n");
	assert.equal(toolLineFromEvent({ type: "tool_execution_end", toolName: "bash" }), undefined);
	assert.equal(isSettled({ type: "agent_settled" }), true);
	assert.equal(isSettled({ type: "agent_end" }), false, "agent_end is not the settle point — retries and compaction follow it");
});

test("a hung sub-agent is cut at the deadline and reported, never left holding the run", async () => {
	const never = new Promise(() => {});
	const t0 = Date.now();
	const out = await raceTimeout(never, 120);
	assert.notEqual(out, undefined);
	assert.ok(Date.now() - t0 < 5_000, "the deadline must win over a promise that never settles");
	assert.equal(await raceTimeout(Promise.resolve("done"), 5_000), "done");
});

test("an abort signal ends the wait immediately, so Esc does not have to wait for the timeout", async () => {
	const ac = new AbortController();
	const never = new Promise(() => {});
	const t0 = Date.now();
	setTimeout(() => ac.abort(), 30);
	await raceTimeout(never, 60_000, ac.signal);
	assert.ok(Date.now() - t0 < 5_000);
});

test("the timer is cleared, so a finished run leaves no stray timeout holding the process open", async () => {
	const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	await Promise.all([raceTimeout(Promise.resolve(1), 60_000), raceTimeout(Promise.resolve(2), 60_000)]);
	const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	assert.ok(after <= before, `timeouts leaked: ${before} → ${after}`);
});
