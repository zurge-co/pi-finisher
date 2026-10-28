import { writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FRESH_SUMMARY_MAX,
	clipSummary,
	freshCompactionEntry,
	readFreshContextConfig,
	writeFreshContextConfig,
} from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-fresh-"));

test("fresh context is on by default, so a lap boundary compacts without any setup", () => {
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
	writeState(cwd, "config.json", "{ this is not json");
	const cfg = readFreshContextConfig(cwd);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.source, "broken-config");
});

test("a lap compaction entry retains nothing, so the next lap starts from the tracker alone", () => {
	const entry = freshCompactionEntry("carry this one line");
	assert.equal(entry.type, "compaction");
	assert.equal(entry.firstKeptEntryId, null, "no entry from before the boundary is kept");
	assert.equal(entry.summary, "carry this one line");
	assert.equal(clipSummary("x".repeat(FRESH_SUMMARY_MAX * 2)).length, FRESH_SUMMARY_MAX, "a summary longer than the cap is cut down to it");
	assert.ok(
		freshCompactionEntry("y".repeat(FRESH_SUMMARY_MAX * 2)).summary.length <= FRESH_SUMMARY_MAX,
		"the entry itself can never smuggle more than the cap past the boundary",
	);
});
