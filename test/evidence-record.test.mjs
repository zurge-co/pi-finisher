import { test } from "node:test";
import assert from "node:assert/strict";
import { appendCommand, detectChecks, finalStatus, judgeChecks, normalizeCommand, recordCall, recordedFailures } from "../extensions/finisher/index.ts";

const bash = (command, isError) => ({ name: "bash", args: { command }, isError });
const rec = (...events) => events.reduce((calls, ev) => recordCall(calls, ev), []);

test("a case is proven only by the command named for it — a claim, or another command's success, proves nothing", () => {
	assert.equal(judgeChecks([], ["node check.mjs"]).result, "UNVERIFIED", "the command never ran, so the case is not proven");
	assert.equal(judgeChecks(rec(bash("npm test", false)), ["node check.mjs"]).result, "UNVERIFIED", "a different command cannot answer for this case");
	assert.equal(judgeChecks([], []).result, "UNVERIFIED", "no named command, no proof");
	assert.equal(judgeChecks(rec(bash("node check.mjs", false)), ["node check.mjs"]).result, "PASS");
	assert.equal(judgeChecks(rec(bash("node check.mjs", true)), ["node check.mjs"]).result, "FAIL", "the harness's own recording decides");
	assert.match(judgeChecks(rec(bash("node check.mjs", true)), ["node check.mjs"]).reason ?? "", /exited non-zero/);
});

test("matching is exact after normalising whitespace, so no case can ride on a prefix or a lookalike", () => {
	assert.equal(normalizeCommand("  npm   test \n -- x "), "npm test -- x");
	const calls = rec(bash("npm   test", false));
	assert.equal(judgeChecks(calls, ["npm test"]).result, "PASS", "whitespace differences are not a different command");
	assert.equal(judgeChecks(calls, ["npm test -- --grep swarm"]).result, "UNVERIFIED", "a longer command is not what ran");
	assert.equal(judgeChecks(calls, ["npm"]).result, "UNVERIFIED", "a prefix is not what ran");
	assert.equal(judgeChecks(rec(bash("npm test", false)), ["npm test", "npm test"]).result, "PASS", "duplicates collapse");
});

test("a case with several named commands needs all of them, and the last status of each decides", () => {
	let calls = rec(bash("node a.mjs", true), bash("node a.mjs", false), bash("node b.mjs", false));
	assert.equal(judgeChecks(calls, ["node a.mjs"]).result, "PASS", "the re-run succeeded, so the case holds");
	assert.equal(judgeChecks(calls, ["node a.mjs", "node b.mjs"]).result, "PASS");
	assert.equal(judgeChecks(calls, ["node a.mjs", "node c.mjs"]).result, "UNVERIFIED", "one missing command is enough to leave it unproven");
	calls = recordCall(calls, bash("node b.mjs", true));
	assert.equal(judgeChecks(calls, ["node a.mjs", "node b.mjs"]).result, "FAIL", "a later failure still wins");
	assert.deepEqual(recordedFailures(calls).map((c) => c.command), ["node b.mjs"]);
	assert.deepEqual([...finalStatus(calls)].sort(), [["node a.mjs", true], ["node b.mjs", false]], "the judgement is exactly the set of commands the harness watched");
});

test("only real shell calls are recorded, so a tool call can never masquerade as evidence", () => {
	let calls = [];
	for (const ev of [bash("  ", false), bash("npm test", false), { name: "read", args: { path: "x" }, isError: true }, { name: "finisher_verify", args: {}, isError: false }, { name: "bash", args: {} }])
		calls = recordCall(calls, ev);
	assert.deepEqual(calls.map((c) => c.command), ["npm test"]);
	assert.equal(recordCall(calls, { name: "read", args: { path: "x" }, isError: false }), calls, "a non-shell call returns the same array, so a caller never has to clear it");
});

test("the recorder keeps the harness's own event and drops anything that is not a shell command, at a bounded size", () => {
	let calls = [];
	assert.deepEqual(appendCommand(calls, { toolName: "read", input: { path: "x" }, isError: false }), calls, "a read is not a command");
	calls = appendCommand(calls, { toolName: "bash", input: { command: "  npm   test " }, isError: false }, 5);
	assert.deepEqual(calls.map((c) => [c.command, c.ok, c.at]), [["npm test", true, 5]], "the command is normalised and its real status kept");
	calls = appendCommand(calls, { toolName: "powershell", input: { command: "Get-ChildItem" }, isError: true }, 6);
	assert.deepEqual(calls.map((c) => [c.command, c.ok]), [["npm test", true], ["Get-ChildItem", false]]);
	for (let i = 0; i < 500; i++) calls = appendCommand(calls, { toolName: "bash", input: { command: `echo ${i}` }, isError: false });
	assert.equal(calls.length, 400, "the recording is bounded, so a long session cannot grow it without limit");
	assert.equal(calls[calls.length - 1].command, "echo 499", "and it keeps the newest");
});

test("the deterministic stage is exactly the repo's own typecheck, lint and test scripts, in a fixed order", () => {
	assert.deepEqual(detectChecks({ scripts: { test: "node --test", typecheck: "tsc", lint: "eslint ." } }).map((c) => c.name), ["typecheck", "lint", "test"], "deterministic and stable");
	assert.deepEqual(detectChecks({ scripts: { test: "node --test" } }).map((c) => c.command), ["npm"]);
	assert.deepEqual(detectChecks({ scripts: { test: "node --test" } })[0].args, ["run", "--silent", "test"]);
	assert.deepEqual(detectChecks({ scripts: { test: "   ", lint: "" } }), [], "a blank script is not a check");
	assert.deepEqual(detectChecks({ scripts: { build: "tsc" } }).map((c) => c.name), [], "only the checks that prove behaviour are run");
	assert.deepEqual(detectChecks(undefined), []);
});
