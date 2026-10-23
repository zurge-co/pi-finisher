import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadSpecFromDisk,
	findSpecArchivePaths,
	discoverResumeState,
} from "../extensions/zense-harness/index.ts";

const SPEC = (version) => ({
	version,
	title: `spec v${version}`,
	intent: "intent",
	scope: [],
	constraints: [],
	criteria: [],
	specDebt: [],
	approved: true,
});

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-resume-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

test("loadSpecFromDisk: no spec.json → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: corrupt JSON → null", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(join(cwd, ".zense", "spec.json"), "{ not json");
		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: invalid shape (non-array criteria / missing title) → null", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		const p = join(cwd, ".zense", "spec.json");
		writeFileSync(p, JSON.stringify({ version: 1, title: "x", scope: [], criteria: "nope" }));
		assert.equal(loadSpecFromDisk(cwd), null);
		writeFileSync(p, JSON.stringify({ version: 1, scope: [], criteria: [] })); 		assert.equal(loadSpecFromDisk(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("loadSpecFromDisk: valid signed spec → adopted with defaults for missing optionals", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 3, title: "t", intent: "i", scope: ["src/"], criteria: [{ id: "C1", text: "x", check: "true" }], approved: true }),
		);
		const s = loadSpecFromDisk(cwd);
		assert.ok(s, "expected a spec");
		assert.equal(s.version, 3);
		assert.equal(s.approved, true);
		assert.deepEqual(s.constraints, []);
		assert.deepEqual(s.specDebt, []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("findSpecArchivePaths: picks the newest archive pair of the requested version only", () => {
	const { cwd, base } = makeRepo();
	try {
		const specs = join(cwd, ".zense", "specs");
		mkdirSync(specs, { recursive: true });
		for (const f of [
			"2026-09-01-00-00-00-v1-a.json",
			"2026-09-01-00-00-00-v1-a.md",
			"2026-09-02-00-00-00-v2-b.json",
			"2026-09-02-00-00-00-v2-b.md",
			"2026-09-03-00-00-00-v2-c.json",
		])
			writeFileSync(join(specs, f), "x");
		const r = findSpecArchivePaths(cwd, 2);
		assert.equal(r.json, join(specs, "2026-09-03-00-00-00-v2-c.json"));
		assert.equal(r.md, join(specs, "2026-09-02-00-00-00-v2-b.md"));
		assert.deepEqual(findSpecArchivePaths(cwd, 9), {});
		assert.deepEqual(findSpecArchivePaths(join(base, "nope"), 1), {});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});




test("discoverResumeState: no spec on disk → null", () => {
	const { cwd, base } = makeRepo();
	try {
		assert.equal(discoverResumeState(cwd), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discoverResumeState: spec only (no worktree/apply) → spec + archive paths, rest absent", () => {
	const { cwd, base } = makeRepo();
	try {
		const specs = join(cwd, ".zense", "specs");
		mkdirSync(specs, { recursive: true });
		writeFileSync(join(specs, "2026-09-20-00-00-00-v3-t.json"), "{}");
		writeFileSync(join(specs, "2026-09-20-00-00-00-v3-t.md"), "# s");
		writeFileSync(
			join(cwd, ".zense", "spec.json"),
			JSON.stringify({ version: 3, title: "t", intent: "i", scope: [], criteria: [], approved: true }),
		);
		const d = discoverResumeState(cwd);
		assert.ok(d, "discovery returned");
		assert.equal(d.spec.version, 3);
		assert.equal(d.specJsonPath, join(specs, "2026-09-20-00-00-00-v3-t.json"));
		assert.equal(d.specMdPath, join(specs, "2026-09-20-00-00-00-v3-t.md"));
		assert.equal(d.worktree, undefined);
		assert.equal(d.pendingApply, undefined);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});





test("discoverResumeState: a signed spec on disk is enough — no worktree or patch state is tracked any more", () => {
	const { cwd, base } = makeRepo();
	try {
		mkdirSync(join(cwd, ".zense"), { recursive: true });
		writeFileSync(join(cwd, ".zense", "spec.json"), JSON.stringify({ version: 5, title: "t", intent: "i", scope: [], criteria: [], approved: true }));
		const d = discoverResumeState(cwd);
		assert.ok(d, "the spec is discovered straight from disk");
		assert.equal(d.spec.version, 5);
		assert.equal(d.spec.approved, true);
		assert.equal("worktree" in d, false, "resume must not resurrect a worktree pointer");
		assert.equal("pendingApply" in d, false, "nor a staged-apply record");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
