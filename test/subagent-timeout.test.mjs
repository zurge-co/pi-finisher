import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentTimeout } from "../extensions/finisher/index.ts";

test("subagentTimeout: per-role map + default fallback (no more env override)", () => {
	assert.equal(subagentTimeout("coder"), 600_000);
	assert.equal(subagentTimeout("verifier"), 300_000, "the verifier role is gone, so it falls back to the default rather than a stale number");
	assert.equal(subagentTimeout("grader"), 300_000, "a dead role falls back to the default, never a stale number");
	assert.equal(subagentTimeout("unknown-role"), 300_000); });

test("subagentTimeout: .finisher/config.json overrides built-in map, read fresh per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-cfg-"));
	try {
				assert.equal(subagentTimeout("coder", dir), 600_000);
		mkdirSync(join(dir, ".finisher"), { recursive: true });
				writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: 900_000 } }));
		assert.equal(subagentTimeout("coder", dir), 900_000); 				writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000 } }));
		assert.equal(subagentTimeout("coder", dir), 45_000);
		assert.equal(subagentTimeout("verifier", dir), 45_000, "a default applies to any role");
				writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000, coder: 120_000 } }));
		assert.equal(subagentTimeout("coder", dir), 120_000);
				writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: 0, default: -5 } }));
		assert.equal(subagentTimeout("coder", dir), 600_000);
		writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: "60k" } }));
		assert.equal(subagentTimeout("coder", dir), 600_000);
				writeFileSync(join(dir, ".finisher", "config.json"), "{oops");
		assert.equal(subagentTimeout("coder", dir), 600_000);
				writeFileSync(join(dir, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: 777_000 } }));
		assert.equal(subagentTimeout("coder", dir), 777_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagentTimeout: cwd without config → falls back to the next dir (worktree → main repo)", () => {
	const wt = mkdtempSync(join(tmpdir(), "finisher-wt-"));
	const main = mkdtempSync(join(tmpdir(), "finisher-main-"));
	try {
		mkdirSync(join(main, ".finisher"), { recursive: true });
		writeFileSync(join(main, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: 800_000 } }));
		assert.equal(subagentTimeout("coder", wt, main), 800_000); 		mkdirSync(join(wt, ".finisher"), { recursive: true });
		writeFileSync(join(wt, ".finisher", "config.json"), JSON.stringify({ subagentTimeoutMs: { coder: 111_000 } }));
		assert.equal(subagentTimeout("coder", wt, main), 111_000); 		assert.equal(subagentTimeout("grader", wt, main), 300_000, "a dead role never picks up a stale per-role timeout"); 	} finally {
		rmSync(wt, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	}
});
