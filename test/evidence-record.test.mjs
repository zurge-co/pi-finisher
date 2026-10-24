import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendVerdict,
	finalStatus,
	isReadonlyTool,
	judgeRecording,
	lastVerdict,
	parseVerdicts,
	recordCall,
	recordedFailures,
	recordingLine,
	resetVerdict,
	registerReadonlyGuard,
	registerVerdictTool,
	verdictPath,
} from "../extensions/finisher/index.ts";

const bash = (command, isError) => ({ name: "bash", args: { command }, isError });
const pass = (why = "the output shows the bound holds") => ({ verdict: "PASS", why });
const rec = (...events) => events.reduce((calls, ev) => recordCall(calls, ev), []);

test("a verdict alone proves nothing, and a PASS over a command the harness saw fail is rejected", () => {
	assert.equal(judgeRecording([], pass()).verdict, "UNVERIFIED", "no recorded command, no proof");
	assert.equal(judgeRecording([], undefined).verdict, "UNVERIFIED", "no verdict record, no judgement");
	assert.equal(judgeRecording(rec(bash("npm test", false)), undefined).verdict, "UNVERIFIED", "a silent run is not a verdict");
	assert.equal(judgeRecording(rec(bash("node probe.mjs", true)), pass()).verdict, "FAIL", "the recording outranks the verdict");
	assert.match(judgeRecording(rec(bash("node probe.mjs", true)), pass()).reason ?? "", /harness recorded/);
	assert.equal(judgeRecording(rec(bash("node probe.mjs", false)), pass()).verdict, "PASS");
	assert.equal(judgeRecording(rec(bash("node probe.mjs", false)), { verdict: "FAIL", why: "the bound leaks" }).verdict, "FAIL");
	assert.equal(judgeRecording(rec(bash("node probe.mjs", false)), { verdict: "UNVERIFIED", why: "needs a human" }).verdict, "UNVERIFIED");
});

test("the recording is per command and the last run decides, so a fixed probe passes and a broken one does not", () => {
	let calls = [];
	for (const step of [["node p.mjs", true], ["node p.mjs", false]]) calls = recordCall(calls, bash(step[0], step[1]));
	assert.deepEqual([...finalStatus(calls)], [["node p.mjs", true]], "one command, judged by its final status: the re-run succeeded");
	assert.equal(calls.length, 2, "the history is kept, the judgement is on the last status");
	assert.equal(judgeRecording(calls, pass()).verdict, "PASS");
	calls = recordCall(calls, bash("node p.mjs", false));
	assert.deepEqual([...finalStatus(calls)], [["node p.mjs", true]]);
	const broke = recordCall(calls, bash("node p.mjs", true));
	assert.equal(judgeRecording(broke, pass()).verdict, "FAIL", "a later failure still wins");
	const two = recordCall(recordCall([], bash("node a.mjs", false)), bash("node b.mjs", true));
	assert.deepEqual(recordedFailures(two).map((c) => c.command), ["node b.mjs"]);
	assert.equal(judgeRecording(two, pass()).verdict, "FAIL", "a different command cannot be erased by another's success");
	assert.deepEqual([...finalStatus(rec(bash("git status", false)))], [["git status", true]], "the status is the tool's own");
});

test("only real bash calls are recorded, so nothing else in a run can be mistaken for evidence", () => {
	let calls = [];
	for (const ev of [bash("  ", false), bash("npm test", false), { name: "read", args: { path: "x" }, isError: true }, { name: "finisher_verdict", args: {}, isError: false }, { name: "bash", args: {} }])
		calls = recordCall(calls, ev);
	assert.deepEqual(calls.map((c) => c.command), ["npm test"], "one command, no phantom entries");
	assert.match(recordingLine(calls), /^ok\s+npm test$/);
	assert.match(recordingLine([]), /no command was recorded/);
});

test("the verdict record survives a round trip and the last one wins, so a retried verifier supersedes itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-verdict-"));
	const path = verdictPath(dir, "case/one with spaces");
	appendVerdict(path, { verdict: "UNVERIFIED", why: "no command yet" });
	appendVerdict(path, pass("now it holds"));
	const last = lastVerdict(path);
	assert.equal(last?.verdict, "PASS");
	assert.equal(last?.why, "now it holds");
	assert.equal(parseVerdicts("not json\n{}\n{\"verdict\":\"PASS\",\"why\":\"ok\"}").length, 1, "junk lines are not verdicts");
	assert.equal(lastVerdict(verdictPath(dir, "never-written")), undefined, "an absent record is not a verdict");
});

test("a verifier cannot write into the repo: the tool list and the hook both refuse it", async () => {
	for (const name of ["write", "edit", "multiedit", "apply_patch", "patch", "delete", "move", "touch"]) assert.equal(isReadonlyTool(name), true, `${name} must be refused`);
	for (const name of ["bash", "read", "grep", "find", "ls", "finisher_verdict"]) assert.equal(isReadonlyTool(name), false, `${name} must stay available`);
	const handlers = [];
	const pi = { on: (ev, h) => handlers.push([ev, h]), registerTool: () => {} };
	assert.equal(registerReadonlyGuard(pi, "swarm"), false, "a coder may write — that is its job");
	assert.equal(handlers.length, 0);
	assert.equal(registerReadonlyGuard(pi, "verifier"), true);
	const hook = handlers.find(([ev]) => ev === "tool_call")[1];
	const blocked = await hook({ toolName: "edit", input: { path: "src/x.ts" } }, { cwd: "/tmp", hasUI: false });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /may not change the repo/);
	assert.equal(await hook({ toolName: "bash", input: { command: "node probe.mjs" } }, { cwd: "/tmp", hasUI: false }), undefined, "the verifier keeps the tools it needs");
});

test("the verdict tool refuses an empty or malformed judgement instead of recording one", async () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-verdict-tool-"));
	process.env.FINISHER_VERDICT_FILE = verdictPath(dir, "c1");
	const tools = [];
	const pi = { on: () => {}, registerTool: (def) => tools.push(def) };
	assert.equal(registerVerdictTool(pi), true);
	const tool = tools.find((t) => t.name === "finisher_verdict");
	const bad = await tool.execute("1", { verdict: "MAYBE", why: "hmm" });
	assert.equal(bad.isError, true);
	const empty = await tool.execute("2", { verdict: "PASS", why: "   " });
	assert.equal(empty.isError, true);
	assert.equal(lastVerdict(process.env.FINISHER_VERDICT_FILE), undefined, "a refused call records nothing");
	const ok = await tool.execute("3", pass());
	assert.equal(ok.isError, undefined);
	assert.equal(lastVerdict(process.env.FINISHER_VERDICT_FILE)?.verdict, "PASS");
	delete process.env.FINISHER_VERDICT_FILE;
	assert.equal(registerVerdictTool({ on: () => {}, registerTool: () => {} }), false, "no file to write means the tool is not offered");
});

test("the start event's args are what makes a recorded call possible: end alone carries no command", async () => {
	const { recordCall: record, toolEventFrom } = await import("../extensions/finisher/index.ts");
	const start = toolEventFrom({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "node probe.mjs" } });
	const end = toolEventFrom({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false });
	assert.equal(start?.phase, "start");
	assert.equal(end?.phase, "end");
	assert.equal("args" in (end ?? {}), false, "pi sends no args on end, so the command must come from the cached start event");
	const cache = new Map();
	const onTool = (tool) => {
		if (tool.phase === "start") return cache.set(tool.id, tool.args);
		const args = cache.get(tool.id);
		cache.delete(tool.id);
		calls = record(calls, { name: tool.name, args, isError: tool.isError });
	};
	let calls = [];
	onTool(start);
	onTool(end);
	assert.deepEqual(calls.map((c) => [c.command, c.ok]), [["node probe.mjs", true]], "the pair records one call with its real status");
	assert.equal(judgeRecording(calls, pass()).verdict, "PASS", "and an honest verifier can now earn its PASS");
	assert.equal(cache.size, 0, "the cache does not grow across a run");
});

test("the harness's own verdict file never dirties the tree a verifier is judged against", async () => {
	const { readFileSync } = await import("node:fs");
	const tools = readFileSync(new URL("../extensions/finisher/src/tools.ts", import.meta.url), "utf8");
	assert.match(tools, /\.finisher\//, "the tree guard must ignore the harness's own verdict directory");
	assert.match(tools, /treeBefore/, "and it must compare the tree around the run");
});

test("a non-bash event never wipes the recording, and a new run never inherits an old verdict", async () => {
	const { recordCall: record } = await import("../extensions/finisher/index.ts");
	const calls = [];
	const apply = (event) => {
		const next = record(calls, event);
		if (next !== calls) {
			calls.length = 0;
			calls.push(...next);
		}
	};
	apply(bash("node probe.mjs", false));
	apply({ name: "finisher_verdict", args: { verdict: "PASS" }, isError: false });
	apply({ name: "read", args: { path: "src/x.ts" }, isError: false });
	assert.deepEqual(calls.map((c) => [c.command, c.ok]), [["node probe.mjs", true]], "the verdict call and the read must not erase the command that earned the pass");
	assert.equal(judgeRecording(calls, pass()).verdict, "PASS", "an honest verifier that records its verdict still passes");
	const naive = [];
	const next = record(naive, { name: "finisher_verdict", args: {}, isError: false });
	assert.equal(next, naive, "recordCall returns the same array when it records nothing — which is why the caller must not clear it");
});

test("a verdict file is cleared before a run, so an old PASS cannot answer for a silent verifier", async () => {
	const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "finisher-reset-"));
	const path = verdictPath(dir, "c9");
	appendVerdict(path, { verdict: "PASS", why: "from an earlier round" });
	assert.equal(lastVerdict(path)?.verdict, "PASS");
	resetVerdict(path);
	assert.equal(existsSync(path), false, "the previous round's record is gone");
	assert.equal(lastVerdict(path), undefined);
	assert.equal(judgeRecording([], lastVerdict(path)).verdict, "UNVERIFIED", "a silent run cannot borrow last round's verdict");
	writeFileSync(path, "");
	assert.equal(lastVerdict(path), undefined, "an empty file is no verdict either");
});
