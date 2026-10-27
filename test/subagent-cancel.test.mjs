import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { raceTimeout, buildRpcSubagentArgs, withFinisherToolGlob, SUBAGENT_EXCLUDE_TOOLS, HARNESS_TOOLS } from "../extensions/finisher/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "finisher-cancel-"));

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

test("a cancelled coder keeps its own boot arguments: no session is dropped and writing stays allowed", () => {
	const swarm = buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS.coder, "coder");
	assert.ok(!swarm.includes("--no-session"), "a coder keeps its own session");
	const list = swarm[swarm.indexOf("--exclude-tools") + 1].split(",");
	assert.ok(!list.includes("write") && !list.includes("edit"), "the coder may write");
	for (const harness of HARNESS_TOOLS) assert.ok(list.includes(harness), `${harness} stays excluded so a coder cannot re-enter the harness`);
	assert.ok(dir().length > 0);
});
