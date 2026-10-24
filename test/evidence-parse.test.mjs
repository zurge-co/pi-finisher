import { test } from "node:test";
import assert from "node:assert/strict";
import { cellExitCode, commandName, COMMAND_BINARIES, EVIDENCE_MARKER, extractCommands, judgeCase } from "../extensions/finisher/index.ts";

const block = (body, verdict = "VERDICT: PASS") => `EVIDENCE:\n${body}\n${verdict}`;
const statusOf = (text) => extractCommands(text).map((c) => [c.command, c.exitCode]);

test("every binary the harness accepts is recognised at the start of a command, and nothing else is", () => {
	for (const bin of COMMAND_BINARIES) assert.equal(commandName(`${bin} --flag`), `${bin} --flag`, bin);
	for (const notACommand of ["I read the diff", "", "   ", "src/swarm.ts:12", "npm-test"]) assert.equal(commandName(notACommand), undefined, notACommand);
	assert.equal(commandName("  $ npm test"), "npm test", "a shell prompt marker is stripped");
	assert.equal(commandName("| 2 | `npm test` | 0 | ok |"), undefined, "a table row is not itself a command");
});

test("a report with a verdict but no evidence block proves nothing — neither a pass nor a failure can be read out of prose", () => {
	const prose = [
		"I read the change and the bound looks right to me.",
		"One earlier draft of my probe exited 1 on my own scripting bug; the final run exited 0.",
		"VERDICT: PASS",
	].join("\n");
	assert.deepEqual(statusOf(prose), [], "nothing in an unmarked report is evidence");
	assert.equal(judgeCase("c1", prose).verdict, "UNVERIFIED", "no evidence can never be a pass");
	const hidden = "`npm test` exited 1 and I never fixed it.\nVERDICT: PASS";
	assert.equal(judgeCase("c1", hidden).verdict, "UNVERIFIED", "and a hidden failure is not read as a failure either — the report simply proves nothing");
	assert.match(judgeCase("c1", prose).reason ?? "", /no command was run/);
});

test("inside a block every spelling of a status is read, and it belongs to the command on that line", () => {
	const forms = [
		["$ node probe.mjs → exit 0", "node probe.mjs"],
		["$ node probe.mjs - exit 0", "node probe.mjs"],
		["$ node probe.mjs | exit 0", "node probe.mjs"],
		["$ node probe.mjs EXIT=0", "node probe.mjs"],
		["node probe.mjs\nexit code 0", "node probe.mjs"],
	];
	for (const [body, command] of forms) {
		const judged = judgeCase("c1", block(body));
		assert.deepEqual(statusOf(block(body)), [[command, 0]], body);
		assert.equal(judged.verdict, "PASS", body);
	}
	const cells = ["| 2 | `npm test` | **0** | 281 pass |", "| 3 | `npm run typecheck` | 0 | clean |", "| 4 | `npm test` | 2 | broken |"];
	assert.deepEqual(cells.map((row) => row.split("|")[3].trim()).map(cellExitCode), [0, 0, 2], "a status cell is read from its own column");
	assert.equal(cellExitCode("281 pass"), undefined, "a result count is never a status");
	assert.equal(cellExitCode("exit code: 7"), 7, "a labelled status is read too");
});

test("a re-run is one command judged by its final status, whatever separator the report uses", () => {
	for (const [first, second] of [
		["$ node probe.mjs → exit 1", "$ node probe.mjs → exit 0"],
		["$ node probe.mjs - exit 1", "$ node probe.mjs → exit 0"],
		["$ node probe.mjs → exit 1", "$ node probe.mjs — exit 0"],
		["$ node probe.mjs → exit 1", "$ node probe.mjs EXIT=0"],
		["$ node probe.mjs → exit 0", "$ node probe.mjs | exit 2"],
	]) {
		const report = block(`${first}\n${second}`);
		assert.equal(extractCommands(report).length, 1, `${first} / ${second} is one command`);
		const expected = second.includes("2") ? "FAIL" : "PASS";
		assert.equal(judgeCase("c1", report).verdict, expected, `${first} / ${second}`);
	}
});

test("inside a block only a line that starts with a command counts: bullets, backticks and indented output are narration", () => {
	const report = block(
		[
			"- a counterexample shows up as `npm test` exit 1",
			"PASS  f: indented probe output printing exit 1 cannot sink a command",
			"$ node /tmp/probe.mjs → exit 0",
			"  probe summary: 12 cases, exit 0",
		].join("\n"),
	);
	assert.deepEqual(statusOf(report), [["node /tmp/probe.mjs", 0]], "only the column-0 command is evidence");
	assert.equal(judgeCase("c1", report).verdict, "PASS", "and the narration cannot turn it into a failure");
	const failing = block("$ node /tmp/probe.mjs → exit 1\n  exit 0");
	assert.equal(judgeCase("c1", failing).verdict, "FAIL", "a failing command is never excused by indented output");
	const borrowed = block("$ node /tmp/probe.mjs\n  probe summary: 12 cases, exit 0");
	assert.equal(judgeCase("c1", borrowed).verdict, "UNVERIFIED", "a status printed in the output is not the command's own");
	const own = block("$ node /tmp/probe.mjs\n  exit 0");
	assert.equal(judgeCase("c1", own).verdict, "PASS", "a bare status line under the command is its own");
});

test("a PASS is rejected when the block shows a failure, and a declared UNVERIFIED is respected", () => {
	const failure = block("$ npm test → exit 1");
	const judged = judgeCase("c1", failure);
	assert.equal(judged.verdict, "FAIL");
	assert.match(judged.reason ?? "", /contradicts itself/);
	assert.match(judged.reason ?? "", /npm test/, "the report names the command that failed");
	assert.equal(judgeCase("c1", block("node probe.mjs\nexit 0", "VERDICT: UNVERIFIED — only a human can see this")).verdict, "UNVERIFIED");
	assert.equal(judgeCase("c1", block("", "VERDICT: PASS")).verdict, "UNVERIFIED", "an empty block proves nothing");
	assert.equal(judgeCase("c1", block("VERDICT: PASS", "")).verdict, "UNVERIFIED", "a report with no verdict line is not a verdict");
});

test("two different commands are two facts: one success cannot erase the other's failure", () => {
	const report = block("$ npm test → exit 0\n$ npm run build → exit 2");
	assert.equal(judgeCase("c1", report).verdict, "FAIL");
	assert.deepEqual(statusOf(report), [["npm test", 0], ["npm run build", 2]]);
});

test("the marker is found however it is decorated, and a fence line is never a command", () => {
	for (const marker of ["EVIDENCE:", "EVIDENCE", "**EVIDENCE:**", "### EVIDENCE", "> EVIDENCE:", "- EVIDENCE:", "  EVIDENCE:  "]) {
		assert.equal(EVIDENCE_MARKER.test(marker), true, marker);
		const report = `${marker}\n$ node probe.mjs → exit 0\nVERDICT: PASS`;
		assert.equal(judgeCase("c1", report).verdict, "PASS", marker);
	}
	assert.equal(EVIDENCE_MARKER.test("evidence of things"), false, "a sentence is not a marker");
	assert.equal(extractCommands(block("```\nexit 0")).length, 0, "a fence line must not be read as a command");
});
