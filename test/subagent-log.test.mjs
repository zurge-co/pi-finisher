import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SUBAGENT_LOG_MAX, finisherDir, pruneSubagentLogs, subagentLogPath } from "../extensions/finisher/index.ts";
import "./helpers/finisher-home.mjs";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-sublog-"));

test("naming a new log caps the project's log directory at the newest files, oldest dropped first, and never touches anything else", () => {
	const cwd = tmpRepo();
	const dir = join(finisherDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const total = SUBAGENT_LOG_MAX + 7;
	const names = Array.from({ length: total }, (_, i) => `2026-01-01-00-00-${String(i).padStart(2, "0")}-coder.log`);
	for (const n of names) writeFileSync(join(dir, n), "x");
	writeFileSync(join(dir, "notes.txt"), "keep me");
	const path = subagentLogPath(cwd, "coder");
	assert.ok(path.endsWith("-coder.log"), "the caller still gets a fresh path for the run");
	assert.equal(path.startsWith(dir), true);
	const left = readdirSync(dir);
	assert.equal(left.filter((n) => n.endsWith(".log")).length, SUBAGENT_LOG_MAX - 1, "with the file about to be written the count lands exactly on the cap");
	assert.ok(left.includes("notes.txt"), "only .log files are pruned");
	const survivors = new Set(left);
	for (const n of names.slice(0, 8)) assert.ok(!survivors.has(n), `${n} sits in the oldest eight and must go`);
	for (const n of names.slice(8)) assert.ok(survivors.has(n), `${n} is among the newest and must stay`);
	writeFileSync(path, "run output");
	assert.equal(readdirSync(dir).filter((n) => n.endsWith(".log")).length, SUBAGENT_LOG_MAX, "once the new log is written the cap holds exactly");
});

test("pruning a missing or empty directory removes nothing and never throws", () => {
	assert.equal(pruneSubagentLogs(join(tmpdir(), `finisher-nope-${randomUUID()}`)), 0);
	const cwd = tmpRepo();
	const path = subagentLogPath(cwd, "coder");
	assert.equal(existsSync(path), false, "the path is only named — the writer creates the file");
	assert.equal(readdirSync(join(finisherDir(cwd), "subagents")).length, 0, "an empty directory stays empty");
});
