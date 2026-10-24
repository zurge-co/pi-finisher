import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TOOL_TIMEOUT_MS,
	MAX_BASH_TIMEOUT_SECONDS,
	MIN_TIMEOUT_MS,
	ensureBashTimeout,
	isValidBashTimeout,
	readToolTimeout,
	settleWithTimeout,
	timeoutSeconds,
	withTimeout,
	timeoutNote,
	applyBashTimeout,
	enforceDeadline,
	TIMED_TOOLS,
	TIMEOUT_RULE,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-timeout-"));

const writeCfg = (cwd, cfg) => {
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "config.json"), JSON.stringify(cfg));
};

test("a bash call that carries no timeout gets one injected — the hole that let a command run forever", () => {
	const input = { command: "sleep 999999" };
	const r = ensureBashTimeout(input, 900_000);
	assert.equal(r.changed, true);
	assert.equal(input.timeout, 900, "bash takes seconds");
	assert.equal(isValidBashTimeout(input.timeout), true);
});

test("a bash timeout already set by the model is respected, never overwritten", () => {
	const input = { command: "npm test", timeout: 120 };
	assert.deepEqual(ensureBashTimeout(input, 900_000), { changed: false, timeout: 120 });
	assert.equal(input.timeout, 120);
});

test("an invalid bash timeout is repaired instead of passed through", () => {
	for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, MAX_BASH_TIMEOUT_SECONDS + 1]) {
		const input = { command: "x", timeout: bad };
		const r = ensureBashTimeout(input, 600_000);
		assert.equal(r.changed, true, `${String(bad)} must not be accepted as-is`);
		assert.equal(input.timeout, 600);
	}
});

test("the injected value is always inside the range pi itself accepts", () => {
	for (const ms of [1, 500, 1_000, 900_000, 10_000_000_000]) {
		const s = timeoutSeconds(ms);
		assert.ok(s >= 1 && s <= MAX_BASH_TIMEOUT_SECONDS, `${ms}ms → ${s}s out of range`);
		assert.equal(Number.isInteger(s), true);
	}
});

test("only bash is touched — the hook never rewrites another tool's arguments", () => {
	assert.equal(applyBashTimeout("read", { path: "x" }, tmpRepo()), false);
	assert.equal(applyBashTimeout("write", { path: "x", content: "y" }, tmpRepo()), false);
	const input = { command: "ls" };
	assert.equal(applyBashTimeout("bash", input, tmpRepo()), true);
	assert.equal(isValidBashTimeout(input.timeout), true);
});

test("the budget is configurable, and a broken config still yields a safe default", () => {
	const cwd = tmpRepo();
	assert.equal(readToolTimeout(cwd, "bash"), DEFAULT_TOOL_TIMEOUT_MS, "no config → default");
	writeCfg(cwd, { toolTimeoutMs: { bash: 45_000 } });
	assert.equal(readToolTimeout(cwd, "bash"), 45_000, "per-tool wins");
	assert.equal(readToolTimeout(cwd, "finisher_swarm"), DEFAULT_TOOL_TIMEOUT_MS, "an unlisted tool keeps the default");
	writeCfg(cwd, { toolTimeoutMs: 60_000 });
	assert.equal(readToolTimeout(cwd, "anything"), 60_000, "a single number applies to everything");
	for (const junk of [{ toolTimeoutMs: { bash: 0 } }, { toolTimeoutMs: { bash: -1 } }, { toolTimeoutMs: { bash: "60s" } }, { toolTimeoutMs: { bash: MIN_TIMEOUT_MS - 1 } }]) {
		writeCfg(cwd, junk);
		assert.equal(readToolTimeout(cwd, "bash"), DEFAULT_TOOL_TIMEOUT_MS, `junk ${JSON.stringify(junk)} must fall back`);
	}
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "config.json"), "{not json");
	assert.equal(readToolTimeout(cwd, "bash"), DEFAULT_TOOL_TIMEOUT_MS, "a corrupt file must not break a tool call");
});

test("a call that never answers is cut off and reported, instead of holding the turn", async () => {
	const never = new Promise(() => {});
	const t0 = Date.now();
	const r = await withTimeout(never, 120, "tool finisher_swarm");
	assert.equal(r.timedOut, true, "an unbounded await must resolve as a timeout");
	assert.ok(Date.now() - t0 < 5_000);
	assert.match(timeoutNote(r), /tool finisher_swarm exceeded its/);
});

test("a normal result passes through untouched, and a rejection still propagates as an error", async () => {
	const ok = await withTimeout(Promise.resolve({ content: [] }), 5_000, "tool x");
	assert.deepEqual(ok, { timedOut: false, value: { content: [] } });
	await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 5_000, "tool x"), /boom/);
});

test("settleWithTimeout returns the caller's fallback only on a real timeout", async () => {
	assert.equal(await settleWithTimeout(Promise.resolve("real"), 5_000, "x", () => "fallback"), "real");
	assert.equal(await settleWithTimeout(new Promise(() => {}), 100, "x", () => "fallback"), "fallback");
});

test("no timer survives a finished call, so a bounded tool cannot keep the process alive", async () => {
	const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	await Promise.all([1, 2, 3].map((i) => withTimeout(Promise.resolve(i), 60_000, `t${i}`)));
	await settleWithTimeout(new Promise(() => {}), 50, "t4", () => 0);
	const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	assert.ok(after <= before, `timeouts leaked: ${before} → ${after}`);
});

test("every finisher tool and every rpc call is registered through a bound, not a raw await", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	const registrations = tools.match(/pi\.registerTool\(/g) ?? [];
	assert.ok(registrations.length >= 3, "every goal tool must still be registered");
	assert.equal((tools.match(/pi\.registerTool\(boundedTool\(/g) ?? []).length, registrations.length, "every registration must go through boundedTool");
	assert.ok(!/pi\.registerTool\(\{\s*\n\s*name:/.test(tools), "no tool may be registered without a bound");

	const rpc = readFileSync(join(here, "extensions/finisher/src/subagent-rpc.ts"), "utf8");
	for (const call of ["client.start()", "client.getMessages()", "client.getState()", "client.stop()", "r.client.steer(", "r.client.followUp(", "client.abort()"]) {
		const at = rpc.indexOf(call);
		assert.ok(at > 0, `${call} must still be used`);
		const line = rpc.slice(rpc.lastIndexOf("\n", at) + 1, rpc.indexOf("\n", at));
		const guarded = /boundedCall|withTimeout|settleWithTimeout/.test(line);
		assert.ok(guarded, `${call} must be bounded, found: ${line.trim()}`);
	}
});

test("the sub-agent hooks the same bash-timeout rule, so the guarantee is not main-agent-only", () => {
	const index = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	const guard = index.indexOf('process.env.PI_FINISHER_SUBAGENT === "1"');
	const hook = index.indexOf("registerToolTimeoutHook(pi)");
	assert.ok(guard > 0 && hook > 0, "both must exist");
	const afterGuard = index.indexOf("registerToolTimeoutHook(pi)", guard);
	assert.ok(afterGuard > guard, "the hook must be registered inside the sub-agent branch too");
});

test("git runs under a timeout — a hung subprocess cannot stall a tool call", () => {
	const wt = readFileSync(join(here, "extensions/finisher/src/worktree.ts"), "utf8");
	assert.match(wt, /timeout: GIT_TIMEOUT_MS/, "every git subprocess carries a deadline");
	assert.match(wt, /killSignal/);
});

test("no command can reach the executor unbounded: every input shape leaves a valid deadline or is refused", () => {
	const shapes = [
		{ command: "sleep 999" },
		{ command: "x", timeout: 30 },
		{ command: "x", timeout: 0 },
		{ command: "x", timeout: -1 },
		{ command: "x", timeout: Number.NaN },
		{ command: "x", timeout: "60" },
		{ command: "x", timeout: null },
		{ command: "x", timeout: MAX_BASH_TIMEOUT_SECONDS + 1 },
		{ command: "x", timeout: 1 },
	];
	for (const tool of TIMED_TOOLS) {
		for (const shape of shapes) {
			const input = { ...shape };
			const r = enforceDeadline(tool, input, tmpRepo());
			if (r.blocked) {
				assert.match(r.reason ?? "", /not a valid deadline/, `${tool} ${JSON.stringify(shape)} must say why it was refused`);
				continue;
			}
			assert.equal(isValidBashTimeout(input.timeout), true, `${tool} ${JSON.stringify(shape)} ran with ${JSON.stringify(input.timeout)}`);
			assert.equal(r.timeout, input.timeout, "the reported deadline is the one the executor sees");
			assert.equal(r.changed, shape.timeout === undefined, "only an omitted timeout is injected");
		}
	}
	const untouched = { path: "x" };
	assert.deepEqual(enforceDeadline("read", untouched, tmpRepo()), { changed: false, timeout: 0, blocked: false }, "a tool without a command is never rewritten");
	assert.equal("timeout" in untouched, false);
});

test("the timeout rule reaches the model, so an injected deadline is never a surprise", () => {
	assert.match(TIMEOUT_RULE, /timeout/);
	assert.match(TIMEOUT_RULE, /SECONDS/);
	const index = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	const prompt = readFileSync(join(here, "extensions/finisher/src/system-prompt.ts"), "utf8");
	assert.match(prompt, /TIMEOUT_RULE/, "the rule is part of the system prompt, not just the hook");
	assert.match(index, /harnessSystemPrompt\(/, "the entry point composes the prompt through the module that owns the rules");
	assert.match(index, /enforceDeadline\(ev\.toolName/, "the hook enforces it on the real tool call");
	assert.match(index, /block: true/, "an unbounded call is refused, not silently rewritten and forgotten");
});
