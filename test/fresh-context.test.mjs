import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FRESH_SUMMARY_MAX,
	buildFreshSummary,
	clipSummary,
	freshCompactionEntry,
	freshStatusLine,
	readFreshContextConfig,
	shouldReset,
	writeFreshContextConfig,
} from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "zense-fresh-"));

test("fresh context is on by default, so a task boundary resets without any setup", () => {
	const cfg = readFreshContextConfig(tmpRepo());
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.source, "default");
});

test("the switch is a real off: it survives the round trip and wins over the default", () => {
	const cwd = tmpRepo();
	assert.equal(writeFreshContextConfig(cwd, false), true);
	const off = readFreshContextConfig(cwd);
	assert.equal(off.enabled, false);
	assert.equal(off.source, "config");
	writeFreshContextConfig(cwd, true);
	assert.equal(readFreshContextConfig(cwd).enabled, true);
});

test("a broken config file never blocks the run — it falls back to the default and says so", () => {
	const cwd = tmpRepo();
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "config.json"), "{ this is not json");
	const cfg = readFreshContextConfig(cwd);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.source, "broken-config");
});

test("the reset fires exactly once per finished task, and never mid-task or on an abort", () => {
	const base = { enabled: true, alreadyReset: false, hasWork: true };
	assert.equal(shouldReset(base), true);
	assert.equal(shouldReset({ ...base, alreadyReset: true }), false, "a second settle in the same task must not reset again");
	assert.equal(shouldReset({ ...base, enabled: false }), false);
	assert.equal(shouldReset({ ...base, hasWork: false }), false);
	assert.equal(shouldReset({ ...base, aborted: true }), false, "an aborted run keeps its context so the human can read it");
});

test("the retained summary is the handoff stack, never raw statistics", () => {
	const items = [
		{ at: 1, from: "swarm", text: "the merge refuses two slices on one path — split by file" },
		{ at: 2, from: "grader", text: "npm test is the only proof that the bound holds" },
	];
	const summary = buildFreshSummary(items);
	assert.match(summary, /the merge refuses two slices on one path/);
	assert.match(summary, /Re-read the repo/);
	assert.ok(!/\bturns\b|\btokens\b|\d+ files? changed/.test(summary), "no stat lines are carried forward");
	assert.equal(buildFreshSummary([]), "", "an empty stack carries nothing, and the caller supplies a bare directive");
});

test("the summary is capped, so a long stack cannot smuggle a whole transcript back in", () => {
	const items = Array.from({ length: 40 }, (_, i) => ({ at: i, from: "swarm", text: `lesson ${i} `.repeat(40) }));
	const summary = buildFreshSummary(items);
	assert.ok(summary.length <= FRESH_SUMMARY_MAX);
	assert.equal(clipSummary("x".repeat(FRESH_SUMMARY_MAX * 2)).length, FRESH_SUMMARY_MAX);
});

test("the compaction entry is retain-none, which is what makes the next task start empty", () => {
	const entry = freshCompactionEntry("carry this one line");
	assert.equal(entry.type, "compaction");
	assert.equal(entry.firstKeptEntryId, null);
	assert.equal(entry.summary, "carry this one line");
	assert.equal(freshCompactionEntry("").firstKeptEntryId, null);
});

test("the status line tells the human both facts they need: the switch and the stack depth", () => {
	const line = freshStatusLine({ enabled: false, source: "config" }, []);
	assert.match(line, /fresh context: OFF \(config\)/);
	assert.match(line, /0 item/);
	assert.match(freshStatusLine({ enabled: true, source: "default" }, [{ at: 1, from: "swarm", text: "x" }]), /1 item/);
});

test("an empty stack is the normal case under a strict classifier, and it still resets cleanly", () => {
	const empty = buildFreshSummary([]);
	assert.equal(empty, "");
	const directive = empty || "[finisher fresh context] a task finished; this context was reset on purpose. Re-read the repo and state from disk instead of trusting memory.";
	const entry = freshCompactionEntry(directive);
	assert.equal(entry.firstKeptEntryId, null, "an empty stack must still retain nothing");
	assert.ok(entry.summary.length > 0, "the next task still gets one line of orientation");
	assert.ok(entry.summary.length <= FRESH_SUMMARY_MAX);
	assert.equal(shouldReset({ enabled: true, alreadyReset: false, hasWork: true }), true, "the reset does not depend on the stack having content");
});
