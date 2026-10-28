import { writeState } from "./helpers/finisher-home.mjs";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentTimeout } from "../extensions/finisher/index.ts";

test("subagentTimeout: per-role map + default fallback (no more env override)", () => {
	assert.equal(subagentTimeout("coder"), 600_000);
	assert.equal(subagentTimeout("verifier"), 300_000, "the verifier role is gone, so it falls back to the default rather than a stale number");
	assert.equal(subagentTimeout("grader"), 300_000, "a dead role falls back to the default, never a stale number");
	assert.equal(subagentTimeout("unknown-role"), 300_000);
});

test("subagentTimeout: config.json in the state dir overrides built-in map, read fresh per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-cfg-"));
	try {
		assert.equal(subagentTimeout("coder", dir), 600_000);
		writeState(dir, "config.json", { subagentTimeoutMs: { coder: 900_000 } });
		assert.equal(subagentTimeout("coder", dir), 900_000);
		writeState(dir, "config.json", { subagentTimeoutMs: { default: 45_000 } });
		assert.equal(subagentTimeout("coder", dir), 45_000);
		assert.equal(subagentTimeout("verifier", dir), 45_000, "a default applies to any role");
		writeState(dir, "config.json", { subagentTimeoutMs: { default: 45_000, coder: 120_000 } });
		assert.equal(subagentTimeout("coder", dir), 120_000);
		writeState(dir, "config.json", { subagentTimeoutMs: { coder: 0, default: -5 } });
		assert.equal(subagentTimeout("coder", dir), 600_000);
		writeState(dir, "config.json", { subagentTimeoutMs: { coder: "60k" } });
		assert.equal(subagentTimeout("coder", dir), 600_000);
		writeState(dir, "config.json", "{oops");
		assert.equal(subagentTimeout("coder", dir), 600_000);
		writeState(dir, "config.json", { subagentTimeoutMs: { coder: 777_000 } });
		assert.equal(subagentTimeout("coder", dir), 777_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagentTimeout: cwd without a config of its own falls back to the next dir (worktree → main repo)", () => {
	const wt = mkdtempSync(join(tmpdir(), "finisher-wt-"));
	const main = mkdtempSync(join(tmpdir(), "finisher-main-"));
	try {
		writeState(main, "config.json", { subagentTimeoutMs: { coder: 800_000 } });
		assert.equal(subagentTimeout("coder", wt, main), 800_000);
		writeState(wt, "config.json", { subagentTimeoutMs: { coder: 111_000 } });
		assert.equal(subagentTimeout("coder", wt, main), 111_000);
		assert.equal(subagentTimeout("grader", wt, main), 300_000, "a dead role never picks up a stale per-role timeout");
	} finally {
		rmSync(wt, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	}
});
