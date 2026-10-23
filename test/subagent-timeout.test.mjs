import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { subagentTimeout } from "../extensions/zense-harness/index.ts";

test("subagentTimeout: per-role map + default fallback (no more env override)", () => {
	assert.equal(subagentTimeout("swarm"), 600_000);
	assert.equal(subagentTimeout("verifier"), 600_000);
	assert.equal(subagentTimeout("grader"), 300_000, "a dead role falls back to the default, never a stale number");
	assert.equal(subagentTimeout("unknown-role"), 300_000); });

test("subagentTimeout: .zense/config.json overrides built-in map, read fresh per call", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-cfg-"));
	try {
				assert.equal(subagentTimeout("verifier", dir), 600_000);
		mkdirSync(join(dir, ".zense"), { recursive: true });
				writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: 900_000 } }));
		assert.equal(subagentTimeout("verifier", dir), 900_000);
		assert.equal(subagentTimeout("swarm", dir), 600_000); 				writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000 } }));
		assert.equal(subagentTimeout("swarm", dir), 45_000);
		assert.equal(subagentTimeout("verifier", dir), 45_000);
				writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { default: 45_000, verifier: 120_000 } }));
		assert.equal(subagentTimeout("verifier", dir), 120_000);
				writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: 0, default: -5 } }));
		assert.equal(subagentTimeout("verifier", dir), 600_000);
		writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: "60k" } }));
		assert.equal(subagentTimeout("verifier", dir), 600_000);
				writeFileSync(join(dir, ".zense", "config.json"), "{oops");
		assert.equal(subagentTimeout("verifier", dir), 600_000);
				writeFileSync(join(dir, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: 777_000 } }));
		assert.equal(subagentTimeout("verifier", dir), 777_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagentTimeout: cwd without config → falls back to the next dir (worktree → main repo)", () => {
	const wt = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const main = mkdtempSync(join(tmpdir(), "zense-main-"));
	try {
		mkdirSync(join(main, ".zense"), { recursive: true });
		writeFileSync(join(main, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: 800_000 } }));
		assert.equal(subagentTimeout("verifier", wt, main), 800_000); 		mkdirSync(join(wt, ".zense"), { recursive: true });
		writeFileSync(join(wt, ".zense", "config.json"), JSON.stringify({ subagentTimeoutMs: { verifier: 111_000 } }));
		assert.equal(subagentTimeout("verifier", wt, main), 111_000); 		assert.equal(subagentTimeout("grader", wt, main), 300_000, "a dead role never picks up a stale per-role timeout"); 	} finally {
		rmSync(wt, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	}
});
