import { test } from "node:test";
import assert from "node:assert/strict";
import { cellExitCode, commandName, COMMAND_BINARIES, extractCommands, judgeCase, unclaimedStatus } from "../extensions/finisher/index.ts";

test("every binary the harness accepts is recognised at the start of a command, and nothing else is", () => {
	for (const bin of COMMAND_BINARIES) assert.equal(commandName(`${bin} --flag`), `${bin} --flag`, bin);
	for (const notACommand of ["I read the diff", "", "   ", "src/swarm.ts:12", "npm-test"]) assert.equal(commandName(notACommand), undefined, notACommand);
	assert.equal(commandName("  $ npm test"), "npm test", "a shell prompt marker is stripped");
	assert.equal(commandName("| 2 | `npm test` | 0 | ok |"), undefined, "a table row is not itself a command");
});

test("real evidence formats all count as executed evidence, and a claim without an exit never does", () => {
	const evidence = [
		"$ node -e \"run()\"\nexit code 0",
		"| 1 | `npm test` | **0** | 281 pass |",
		"ran `node --test test/x.test.mjs` → EXIT=0",
		"| 3 | `npm run typecheck` | 0 | clean |",
		"node --no-warnings --test test/a.test.mjs\nEXIT=0",
	];
	for (const text of evidence) {
		const commands = extractCommands(`${text}\nVERDICT: PASS`);
		assert.ok(commands.length >= 1, `no command recognised in: ${text}`);
		assert.ok(commands.some((c) => c.exitCode === 0), `no exit 0 near: ${text}`);
		assert.equal(judgeCase("c1", `${text}\nVERDICT: PASS`).verdict, "PASS");
	}
	for (const claim of ["I read the diff, it looks right.\nVERDICT: PASS", "ran `npm test` and it looked fine\nVERDICT: PASS", "VERDICT: PASS"]) {
		assert.equal(judgeCase("c1", claim).verdict, "UNVERIFIED", `a claim without an exit status must not pass: ${claim}`);
	}
});

test("a failing exit wins over a declared PASS, in every format", () => {
	const failing = [
		"| 1 | `npm test` | **1** | 3 failing |\nVERDICT: PASS",
		"$ node -e run()\nexit code 1\nVERDICT: PASS",
		"ran `npm run typecheck` → EXIT=2\nVERDICT: PASS",
		"`node /tmp/probe.mjs`\nexit status: 1\nVERDICT: PASS",
	];
	for (const text of failing) assert.equal(judgeCase("c1", text).verdict, "FAIL", text);
});

test("a PASS needs a reported status of 0 — an unreported or failing status can never verify", () => {
	for (const text of ["`npm test` ran fine\nVERDICT: PASS", "`npm test`\nVERDICT: PASS", "VERDICT: PASS"]) assert.equal(judgeCase("c1", text).verdict, "UNVERIFIED", text);
	for (const text of ["`node --test test/a.test.mjs`\nexit 0\nVERDICT: PASS", "node --test a.test.mjs (exit status: 0)\nVERDICT: PASS", "$ node x\nexit code 0\nVERDICT: PASS"])
		assert.equal(judgeCase("c1", text).verdict, "PASS", text);
});

test("a command can never borrow another command's exit status — a failing report cannot be read as green", () => {
	const mixed = [
		"`node --test a.test.mjs` exited 1\n\n`npm test`\nexit 0\nVERDICT: PASS",
		"node --test a.test.mjs → exit 1\n`npm test` exit 0\nVERDICT: PASS",
		"```\n`node --test a.test.mjs`\nexit 1\n```\nVERDICT: PASS",
		"| `npm run typecheck` | exit code 2 |\n| `npm test` | 0 |\nVERDICT: PASS",
	];
	for (const text of mixed) assert.equal(judgeCase("c1", text).verdict, "FAIL", text);
	for (const text of mixed) assert.ok(extractCommands(text).every((c) => c.command && c.exitCode !== undefined), "every command keeps its own status");
});

test("a status the allowlist cannot attribute is still evidence — a failing bash/git command cannot be ignored", () => {
	const ignored = [
		"bash test.sh → exit 1\n`npm test`\nexit 0\nVERDICT: PASS",
		"curl -s localhost:1 exited 1\n| `npm test` | 0 |\nVERDICT: PASS",
		"git status --porcelain failed, exit code 1\nVERDICT: PASS",
	];
	for (const text of ignored) assert.equal(judgeCase("c1", text).verdict, "FAIL", text);
	assert.equal(unclaimedStatus("bash test.sh → exit 1"), true);
	assert.equal(unclaimedStatus("`npm test` exit 0"), false, "an owned command is never double-counted");
	assert.equal(unclaimedStatus("nothing to see"), false);
	assert.equal(judgeCase("c1", "bash run.sh\nexit 0\nVERDICT: PASS").verdict, "UNVERIFIED", "a status nobody can attribute to a reported command proves nothing — and must never be turned into a PASS");
});

test("a line that only looks like an opening fence is not a command", () => {
	assert.equal(extractCommands("```\nexit 0").length, 0, "a fence line must not be read as a command");
	assert.equal(judgeCase("c1", "```\nexit 0\nVERDICT: PASS").verdict, "UNVERIFIED");
});

test("every spelling of an exit status is read the same way", () => {
	for (const line of ["exit 0", "exit code 0", "exit status: 0", "EXIT=0", "Exit code: 0", "exit status = 0", "EXIT = 0"]) {
		const commands = extractCommands(`node --test a.test.mjs\n${line}`);
		assert.equal(commands[0]?.exitCode, 0, line);
	}
});

test("a result count is never read as an exit status — a count cell is not a status", () => {
	for (const count of ["12 tests, 0 fail", "281 tests passed", "12 passed", "3 failing", "5/5 pass", "98%"]) assert.equal(cellExitCode(count), undefined, count);
	for (const [cell, code] of [
		["0", 0],
		["**0**", 0],
		["`1`", 1],
		["-2", -2],
		["exit 0", 0],
		["exit code 2", 2],
		["EXIT: 127", 127],
	]) assert.equal(cellExitCode(cell), code, cell);
	for (const passing of ["| 1 | `npm test` | 12 tests, 0 fail |", "| 1 | `npm test` | 281 tests passed |", "| 1 | `npm test` | 5/5 pass |"]) {
		const verdict = judgeCase("c1", `${passing}\nVERDICT: PASS`).verdict;
		assert.notEqual(verdict, "FAIL", `a count must never fabricate an exit status: ${passing}`);
		assert.equal(verdict, "UNVERIFIED", `no exit was reported, so nothing was proven: ${passing}`);
	}
});

test("the same command reported once is one piece of evidence, not a repeated claim", () => {
	const repeated = Array.from({ length: 20 }, () => "| `npm test` | 0 | ok |").join("\n");
	assert.equal(extractCommands(repeated).length, 1);
	const many = Array.from({ length: 60 }, (_, i) => `| \`node --test t${i}.test.mjs\` | 0 | ok |`).join("\n");
	assert.ok(extractCommands(many).length <= 40, "the evidence list is bounded, so one report cannot flood the verdict");
});
