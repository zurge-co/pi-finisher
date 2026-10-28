import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOG_TAIL_BYTES,
	LOG_TAIL_LINES,
	judgeDeterministic,
	readTailLines,
	runCheck,
	runChecks,
	runCommand,
	tailWindow,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;

const waitForPeer = (mine, theirs) =>
	[
		"-e",
		`const fs=require('node:fs');fs.writeFileSync('${mine}','1');const until=Date.now()+20000;while(Date.now()<until){if(fs.existsSync('${theirs}'))process.exit(0);const s=Date.now()+10;while(Date.now()<s){};}process.exit(9)`,
	];

test("verify's own path stays off the event loop: timers keep firing while a case command runs", async () => {
	const command = `node -e "setTimeout(() => {}, 700)"`;
	let ticks = 0;
	const timer = setInterval(() => {
		ticks += 1;
	}, 5);
	const started = Date.now();
	const judged = judgeDeterministic(["the command runs"], new Map([["the command runs", command]]), [], [], (line) => runCommand(line, process.cwd(), 30_000));
	const waited = await new Promise((resolve) => setTimeout(() => resolve(Date.now() - started), 150));
	assert.ok(ticks > 0, "a blocking runner shows zero timer ticks until the command is over");
	assert.ok(waited < 600, `a 150ms timer must fire long before a 700ms command ends, it fired at ${waited}ms`);
	const evidence = await judged;
	clearInterval(timer);
	assert.equal(evidence[0].result, "PASS", "and the verdict is still the command's real exit code");
	assert.ok(ticks >= 20, `the loop ran for the whole command, only ${ticks} ticks`);
});

test("two checks really overlap: a check that waits for its peer finishes, so nothing is quietly serialised", async () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-overlap-"));
	const results = await runChecks(
		[
			{ name: "a", command: process.execPath, args: waitForPeer("a.started", "b.started") },
			{ name: "b", command: process.execPath, args: waitForPeer("b.started", "a.started") },
		],
		dir,
		25_000,
	);
	assert.deepEqual(results.map((r) => r.status), ["pass", "pass"], "a serialised runner would leave the first check waiting for a peer that never starts");
	assert.deepEqual(results.map((r) => r.name), ["a", "b"], "the result order is still the check order");
});

test("the verify path spawns nothing synchronously: no execFileSync, and both runners hand back a promise", async () => {
	for (const name of ["check-runner.ts", "verify-checks.ts"]) {
		const source = readFileSync(join(here, "extensions/finisher/src", name), "utf8");
		assert.equal(/execFileSync|spawnSync|execSync/.test(source), false, `${name} must never block the loop a render waits on`);
	}
	const pending = runCheck({ name: "c", command: process.execPath, args: ["-e", "0"] }, process.cwd(), 20_000);
	assert.ok(pending instanceof Promise, "a check is awaited, not merely returned");
	assert.equal((await pending).exitCode, 0);
});

test("a command's own status is the verdict, for every status: zero passes and nothing else does", async () => {
	for (const code of [0, 1, 2, 7, 42, 127]) {
		const result = await runCommand(`exit ${code}`, process.cwd(), 20_000);
		assert.equal(result.exitCode, code, `exit ${code} is reported as ${code}`);
		assert.equal(result.status, code === 0 ? "pass" : "fail", `exit ${code} decides the status`);
	}
	const hung = await runCommand("sleep 60", process.cwd(), 1_000);
	assert.notEqual(hung.exitCode, 0, "a command cut by its deadline is never a pass");
});

test("the tail reader is bounded by bytes and by lines, whatever the file's size is", () => {
	for (const size of [0, 1, 999, 10_000_000]) {
		const { from, length } = tailWindow(size, 4096);
		assert.equal(from + length, size, `${size}: the window ends exactly at the end of the file`);
		assert.ok(length <= 4096 && length <= size, `${size}: the window never reads past the ceiling`);
	}
	const dir = mkdtempSync(join(tmpdir(), "finisher-tail-"));
	for (const total of [5, 400, 200_000]) {
		const path = join(dir, `tail-${total}.log`);
		const lines = Array.from({ length: total }, (_, i) => `line ${i} ${"x".repeat(20)}`);
		writeFileSync(path, lines.join("\n"));
		const tail = readTailLines(path, { maxBytes: 4096, maxLines: 12 });
		assert.ok(tail.length >= 1 && tail.length <= 12, `${total} lines: the tail is capped at the line ceiling, ${tail.length} lines came back`);
		assert.ok(tail.length <= Math.max(1, Math.floor(4096 / lines[0].length)), `${total} lines: and at what the byte window holds`);
		assert.equal(tail[tail.length - 1], lines[total - 1], `${total} lines: the newest line is the one that survives`);
		assert.equal(tail.every((line) => lines.includes(line)), true, `${total} lines: every surviving line is a whole real line, never a half one`);
		assert.ok(tail[0] !== lines[0] || total <= 12, `${total} lines: the head is dropped instead of the file being read whole`);
	}
	const big = join(dir, "tail-200000.log");
	const narrow = readTailLines(big, { maxBytes: 64, maxLines: LOG_TAIL_LINES });
	assert.ok(narrow.length <= LOG_TAIL_LINES, "a byte ceiling this small still yields whole lines within the line ceiling");
	assert.match(narrow[narrow.length - 1], /^line 199999 /, "and they come from the end of the file");
	assert.equal(readTailLines(join(dir, "missing.log")), undefined, "a missing log is not an error");
	assert.equal(readTailLines(undefined), undefined);
	assert.ok(LOG_TAIL_BYTES >= 4096, "the default window is a real tail, not a line or two");
});
