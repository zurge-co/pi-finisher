import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_TIMEOUT_MS, gitOk, excludeFromGitStatus, planSlices } from "../extensions/finisher/index.ts";

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "finisher-git-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { base, cwd, git };
};

test("gitOk reports success with output and failure with a one-line reason, never throwing", () => {
	const { base, cwd } = makeRepo();
	try {
		const ok = gitOk(["rev-parse", "--is-inside-work-tree"], cwd);
		assert.equal(ok.ok, true);
		assert.equal(ok.out.trim(), "true");
		const bad = gitOk(["rev-parse", "no-such-ref"], cwd);
		assert.equal(bad.ok, false);
		assert.ok(bad.err.length > 0);
		assert.equal(bad.err.split("\n").length, 1, "the error stays one line");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("gitOk outside a repo is a plain failure, not a crash", () => {
	const outside = mkdtempSync(join(tmpdir(), "finisher-nogit-"));
	try {
		const r = gitOk(["rev-parse", "--is-inside-work-tree"], outside);
		assert.equal(r.ok, false);
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("every git call is bounded — a hung subprocess cannot stall a tool call", () => {
	assert.ok(GIT_TIMEOUT_MS > 0 && GIT_TIMEOUT_MS <= 300_000);
	const src = readFileSync(join(new URL("..", import.meta.url).pathname, "extensions/finisher/src/worktree.ts"), "utf8");
	assert.match(src, /timeout: GIT_TIMEOUT_MS/);
	assert.match(src, /killSignal/);
});

test("excludeFromGitStatus keeps a generated directory out of the repo's status", () => {
	const { base, cwd, git } = makeRepo();
	try {
		const gen = join(cwd, ".finisher", "worktree", "swarm");
		mkdirSync(gen, { recursive: true });
		writeFileSync(join(gen, "slice.txt"), "x\n");
		assert.match(git(["status", "--porcelain"]), /\.finisher/, "visible before excluding (git folds it into .finisher/)");
		excludeFromGitStatus(cwd, join(cwd, ".finisher", "worktree"));
		assert.equal(git(["status", "--porcelain"]).includes(".finisher"), false, "hidden after excluding");
		excludeFromGitStatus(cwd, join(cwd, ".finisher", "worktree"));
		const lines = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l.includes("worktree"));
		assert.equal(lines.length, 1, "excluding twice must not duplicate the entry");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("no module creates a worktree for the main agent — only the coder slices do", () => {
	const here = new URL("..", import.meta.url).pathname;
	const files = readdirSync(join(here, "extensions/finisher/src"));
	assert.ok(!files.includes("spec-flow.ts"), "the spec flow is gone");
	const code = readFileSync(join(here, "extensions/finisher/src/code-swarm.ts"), "utf8");
	assert.match(code, /workerWorktree/);
	const index = readFileSync(join(here, "extensions/finisher/index.ts"), "utf8");
	assert.ok(!index.includes("applyRedirect"), "no path rewriting anywhere");
});

test("slice isolation for parallel coders survives: each slice still gets its own checkout", () => {
	const here = new URL("..", import.meta.url).pathname;
	const code = readFileSync(join(here, "extensions/finisher/src/code-swarm.ts"), "utf8");
	assert.match(code, /workerWorktree/, "coders still run in per-slice worktrees");
	assert.match(code, /dropWorkerWorktree/);
	const plan = readFileSync(join(here, "extensions/finisher/src/swarm-code.ts"), "utf8");
	assert.match(plan, /planSlices/);
	const plans = planSlices([{ id: "a", instruction: "x", scope: ["f1"] }, { id: "b", instruction: "y", scope: ["f2"] }], "/tmp/slices", "run1");
	assert.equal(plans.length, 2);
	assert.notEqual(plans[0].worktreeDir, plans[1].worktreeDir, "two slices never share a checkout");
	assert.notEqual(plans[0].branch, plans[1].branch, "nor a branch");
});
