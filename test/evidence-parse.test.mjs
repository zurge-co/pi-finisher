import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
import { cellExitCode, commandName, COMMAND_BINARIES, EVIDENCE_MARKER, extractCommands, judgeCase, unclaimedStatus } from "../extensions/finisher/index.ts";

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

test("a command re-run after its own failure is judged by its final status, so fixing a broken probe is not a failed case", () => {
	const iterated = "$ node /tmp/probe.mjs\nexit 1\n$ node /tmp/probe.mjs\nexit 0\nVERDICT: PASS";
	const judged = judgeCase("c1", iterated);
	assert.equal(judged.commands.length, 1, "one command reported twice is one piece of evidence");
	assert.equal(judged.commands[0].exitCode, 0, "the last run of a command is what it did");
	assert.equal(judged.verdict, "PASS");
	const neverFixed = "$ node /tmp/probe.mjs\nexit 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", neverFixed).verdict, "FAIL", "a claim of PASS over a command that last exited 1 is still a contradiction");
	const brokeIt = "$ node /tmp/probe.mjs\nexit 0\n$ node /tmp/probe.mjs\nexit 2\nVERDICT: PASS";
	assert.equal(judgeCase("c1", brokeIt).verdict, "FAIL", "a later failure is not hidden by an earlier success");
	const twoDifferent = "node a.mjs\nexit 0\nnode b.mjs\nexit 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", twoDifferent).verdict, "FAIL", "two different commands are two facts, not one");
});

test("narrative about an earlier mistake is not a command: only a status that names something run counts", () => {
	const narration = "(Two earlier drafts of my own probe exited 1 on my scripting bugs, not on repo code.)";
	assert.equal(unclaimedStatus(narration), false, "a sentence about a mistake names no command, so it is not evidence");
	const report = `$ node --no-warnings /tmp/hud.mjs  → exit 0\n${narration}\nVERDICT: PASS`;
	assert.equal(judgeCase("c1", report).verdict, "PASS", "clean evidence is not undone by prose about the verifier's own drafts");
	for (const real of ["bash test.sh → exit 1", "curl -s localhost:1 exited 1", "git status --porcelain failed, exit code 1", "the node probe exited 1"]) {
		assert.equal(unclaimedStatus(real), true, `${real} names something that was run`);
		assert.equal(judgeCase("c1", `${real}\nVERDICT: PASS`).verdict, "FAIL", `${real} must still sink a claim of PASS`);
	}
	assert.equal(judgeCase("c1", `${narration}\nVERDICT: PASS`).verdict, "UNVERIFIED", "prose alone never verifies anything either");
});

test("only the evidence block is evidence: quoted failing commands in prose cannot sink a clean run, and inside the block nothing is excused", () => {
	const quoted = [
		"## what I fixed",
		"The harness appends `fix parser-roundtrip FAIL` — the case text quotes `node -e \"parser-roundtrip()\"` exited 1, which is why the lap exists.",
		"",
		"EVIDENCE:",
		"$ node --no-warnings /tmp/verify-once.mjs  → exit 0",
		"",
		"VERDICT: PASS — the fix path keeps prior laps and times.",
	].join("\n");
	assert.equal(judgeCase("c1", quoted).verdict, "PASS", "prose that quotes a failing command is not a command the verifier ran");
	const inside = [
		"EVIDENCE:",
		"$ node --no-warnings /tmp/verify-once.mjs  → exit 0",
		"$ node -e \"parser-roundtrip()\"  → exit 1",
		"VERDICT: PASS",
	].join("\n");
	assert.equal(judgeCase("c1", inside).verdict, "FAIL", "a failing command inside the evidence block is never excused");
	const noMarker = "node /tmp/x.mjs\nexit 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", noMarker).verdict, "FAIL", "without the block the whole report is still evidence, so the old guard holds");
	const onlyVerdict = "EVIDENCE:\nVERDICT: PASS";
	assert.equal(judgeCase("c1", onlyVerdict).verdict, "UNVERIFIED", "an empty block proves nothing");
});

test("the command name never swallows its own status, so the same-line re-run form collapses like every other form", () => {
	for (const [first, second] of [
		["$ node probe.mjs → exit 1", "$ node probe.mjs → exit 0"],
		["$ node probe.mjs - exit 1", "$ node probe.mjs - exit 0"],
		["$ node probe.mjs | exit 1", "$ node probe.mjs | exit 0"],
		["node probe.mjs EXIT=1", "node probe.mjs EXIT=0"],
	]) {
		const report = `EVIDENCE:\n${first}\n${second}\nVERDICT: PASS`;
		const commands = extractCommands(report);
		assert.equal(commands.length, 1, `${first} / ${second} is one command, got ${JSON.stringify(commands.map((c) => c.command))}`);
		assert.equal(commands[0].exitCode, 0, "the final run of a command is what it did");
		assert.equal(judgeCase("c1", report).verdict, "PASS");
	}
	const broke = "EVIDENCE:\n$ node probe.mjs → exit 0\n$ node probe.mjs → exit 2\nVERDICT: PASS";
	assert.equal(judgeCase("c1", broke).verdict, "FAIL", "a later failure still wins, in every form");
	const two = "EVIDENCE:\n$ node a.mjs → exit 0\n$ node b.mjs → exit 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", two).verdict, "FAIL", "two commands are two facts");
});

test("a command sits at column 0 and its output is indented, so pasted output cannot be read as new commands", () => {
	const report = [
		"EVIDENCE:",
		"$ node --no-warnings /tmp/probe.mjs → exit 0",
		"  B dash   `$ cmd - exit 1` then `- exit 0` → commands=1 verdict=PASS  exit 0",
		"  N7 unnamed failing line still FAILs → exit 1",
		"VERDICT: PASS",
	].join("\n");
	const commands = extractCommands(report);
	assert.equal(commands.length, 1, `only the column-0 command is evidence, got ${JSON.stringify(commands.map((c) => c.command))}`);
	assert.equal(commands[0].exitCode, 0);
	assert.equal(judgeCase("c1", report).verdict, "PASS", "a probe printing statuses in its output is not a failing probe");
	const realFailureStillCounts = ["EVIDENCE:", "$ node probe.mjs → exit 1", "  VERDICT: PASS", ""].join("\n");
	assert.equal(judgeCase("c1", realFailureStillCounts).verdict, "FAIL", "indentation never excuses a command that failed");
	assert.match(readFileSync(join(here, "extensions/finisher/src/swarm.ts"), "utf8"), /EVIDENCE:/, "the protocol the verifier is taught is the protocol the judge reads");
});

test("a re-run is one command whatever separator the verifier switches to, and a status can never be borrowed from indented output", () => {
	for (const [first, second] of [
		["$ node probe.mjs → exit 1", "$ node probe.mjs - exit 0"],
		["$ node probe.mjs - exit 1", "$ node probe.mjs → exit 0"],
		["$ node probe.mjs → exit 1", "$ node probe.mjs — exit 0"],
		["$ node probe.mjs → exit 1", `${"$ node probe.mjs"} EXIT=0`],
	]) {
		const report = `EVIDENCE:\n${first}\n${second}\nVERDICT: PASS`;
		assert.equal(extractCommands(report).length, 1, `${first} / ${second} is one command`);
		assert.equal(judgeCase("c1", report).verdict, "PASS", "a green re-run is green in every separator");
	}
	const borrowed = "EVIDENCE:\n$ node probe.mjs\n  probe summary: 12 cases, exit 0\nVERDICT: PASS";
	assert.equal(judgeCase("c1", borrowed).verdict, "UNVERIFIED", "printed output that happens to read `exit 0` is not the command's own status");
	const ownStatus = "EVIDENCE:\n$ node probe.mjs\n  exit 0\nVERDICT: PASS";
	assert.equal(judgeCase("c1", ownStatus).verdict, "PASS", "a bare status line under the command is still its own status");
	const failingBorrow = "EVIDENCE:\n$ node probe.mjs\n  exit 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", failingBorrow).verdict, "FAIL", "and a failure is never hidden either");
});

test("the evidence marker is found however the verifier decorates it, so earlier drafts never count as evidence", () => {
	for (const marker of ["EVIDENCE:", "**EVIDENCE:**", "### EVIDENCE", "> EVIDENCE:", "**EVIDENCE**", "- EVIDENCE:", "  EVIDENCE:  "]) {
		const report = [
			"first draft: `node probe.mjs → exit 1` (my fixture bug)",
			"",
			marker,
			"$ node probe.mjs → exit 0",
			"",
			"VERDICT: PASS",
		].join("\n");
		assert.equal(judgeCase("c1", report).verdict, "PASS", `a draft above ${JSON.stringify(marker)} is narration`);
		const dirty = ["EVIDENCE:", "$ node probe.mjs → exit 1", "VERDICT: PASS"].join("\n");
		assert.equal(judgeCase("c1", dirty).verdict, "FAIL", `a failure inside the block still fails (${marker})`);
	}
	assert.equal(EVIDENCE_MARKER.test("evidence of things"), false, "a sentence is not a marker");
});

test("inside an explicit block only commands are read: property bullets and their exit codes are narration, a real failing command is not", () => {
	const bullets = [
		"EVIDENCE:",
		"- every marker decoration opens the same region, so an earlier exit 1 then exit 0 is PASS",
		"- indented probe output printing `exit 1` is never parsed as a command",
		"$ node --no-warnings /tmp/probe.mjs → exit 0",
		"VERDICT: PASS",
	].join("\n");
	assert.equal(judgeCase("c1", bullets).verdict, "PASS", "a bullet that mentions an exit code is a claim about the protocol, not a command anyone ran");
	assert.equal(extractCommands(bullets).length, 1, "only the column-0 command is evidence inside the block");
	const realFailure = ["EVIDENCE:", "$ node probe.mjs → exit 1", "VERDICT: PASS"].join("\n");
	assert.equal(judgeCase("c1", realFailure).verdict, "FAIL", "the guard is not loosened where it matters");
	const noMarker = "git status --porcelain failed, exit code 1\nVERDICT: PASS";
	assert.equal(judgeCase("c1", noMarker).verdict, "FAIL", "without a block the whole report is still evidence, as before");
});

test("inside a block a command is a line that starts with one: a backticked mention on a bullet is narration, not evidence", () => {
	const bullets = [
		"EVIDENCE:",
		"- a counterexample shows up as `npm test` exit 1",
		"- `npm run typecheck` exit 0",
		"$ node /tmp/probe.mjs → exit 0",
		"VERDICT: PASS",
	].join("\n");
	assert.equal(judgeCase("c1", bullets).verdict, "PASS", "a bullet quoting a command is a claim about the protocol");
	assert.deepEqual(extractCommands(bullets).map((c) => [c.command, c.exitCode]), [["node /tmp/probe.mjs", 0]], "only the line that starts with a command is evidence");
	const real = ["EVIDENCE:", "$ npm test → exit 1", "VERDICT: PASS"].join("\n");
	assert.equal(judgeCase("c1", real).verdict, "FAIL", "a command that starts the line still fails, as it must");
	const outside = "ran `node --test test/x.test.mjs` → EXIT=0\nVERDICT: PASS";
	assert.equal(judgeCase("c1", outside).verdict, "PASS", "without a block the old, looser reading is untouched");
});

test("an unattributed status counts only when the line really invokes a program, so a sentence that quotes a status stays narration", () => {
	for (const real of ["bash test.sh → exit 1", "curl -s localhost:1 exited 1", "git status --porcelain failed, exit code 1", "the node probe exited 1"])
		assert.equal(judgeCase("c1", `${real}\nVERDICT: PASS`).verdict, "FAIL", `${real} names something that was run`);
	for (const narration of [
		"PASS  f: indented probe output printing exit 1 cannot sink a clean command",
		"- the rule is separator-normalized: exit 1 then exit 0",
		"Two earlier drafts of my own probe exited 1",
	])
		assert.equal(unclaimedStatus(narration), false, `narration: ${narration}`);
});
