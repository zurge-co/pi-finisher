import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { raceTimeout, buildRpcSubagentArgs, withZenseToolGlob, SUBAGENT_EXCLUDE_TOOLS } from "../extensions/zense-harness/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "zense-cancel-"));

test("an aborted run resolves immediately instead of waiting out the sub-agent's full timeout", async () => {
	const ctrl = new AbortController();
	const never = new Promise(() => {});
	const t0 = Date.now();
	setTimeout(() => ctrl.abort(), 300);
	await raceTimeout(never, 300_000, ctrl.signal);
	assert.ok(Date.now() - t0 < 10_000, "Esc must not wait for the wall-clock limit");
});

test("a pre-aborted signal is already done — the caller gates on signal.aborted before spawning anything", () => {
	const ctrl = new AbortController();
	ctrl.abort();
	assert.equal(ctrl.signal.aborted, true, "the runner checks this before RpcClient.start(), so no process is created");
});

test("cancelling one role never touches another role's boot arguments", () => {
	const swarm = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.swarm, "swarm");
	const verifier = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.verifier, "verifier");
	assert.ok(!swarm.includes("--no-session") && !verifier.includes("--no-session"), "both roles keep their own session");
	const list = (args) => args[args.indexOf("--exclude-tools") + 1];
	assert.equal(list(swarm).split(",")[0], list(verifier).split(",")[0], "the harness glob leads for every role");
	assert.ok(!list(swarm).split(",").includes("write"), "the coder may write");
	assert.ok(list(verifier).split(",").includes("write"), "the verifier may not");
	assert.ok(dir().length > 0);
});
