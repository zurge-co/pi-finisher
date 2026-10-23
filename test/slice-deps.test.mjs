import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectTestCommand, parseWorkerTests, buildCodeWorkerPrompt, linkDeps, excludeInWorktree } from "../extensions/zense-harness/index.ts";

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-slice-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args, at = cwd) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
	writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { base, cwd, git };
};

test("a slice checkout can reach the repo's dependencies without installing anything", () => {
	const { base, cwd, git } = makeRepo();
	const wt = join(base, "slice-a");
	try {
		mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		git(["worktree", "add", wt, "-b", "slice-a"]);
		assert.equal(existsSync(join(wt, "node_modules")), false, "a fresh slice starts without deps");
		symlinkSync(join(cwd, "node_modules"), join(wt, "node_modules"), "dir");
		assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true, "the slice links, it does not copy");
		assert.equal(readFileSync(join(wt, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n", "and the dependency really resolves");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("linking the dependency keeps the slice's diff and the merge clean", () => {
	const { base, cwd, git } = makeRepo();
	const wt = join(base, "slice-b");
	try {
		mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "x\n");
		git(["worktree", "add", wt, "-b", "slice-b"]);
		assert.equal(linkDeps(cwd, wt), true, "the real helper links it");
		assert.match(git(["status", "--porcelain"], wt), /^$/m, "and the slice's status stays clean");
		writeFileSync(join(wt, "src.ts"), "export const a = 1;\n");
		git(["add", "-A"], wt);
		const diff = git(["diff", "--cached", "HEAD", "--", "."], wt);
		assert.match(diff, /src\.ts/);
		assert.ok(!diff.includes("node_modules"), `the diff must not carry dependencies, got:\n${diff.slice(0, 200)}`);
		assert.equal(linkDeps(cwd, wt), false, "linking twice is a no-op");
		assert.equal(excludeInWorktree(wt, "node_modules"), true, "the exclude is idempotent");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("linking is skipped safely when there is nothing to link", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nolink-"));
	try {
		assert.equal(existsSync(join(base, "node_modules")), false, "no deps in the repo → nothing happens");
		const target = join(base, "wt");
		mkdirSync(target, { recursive: true });
		assert.equal(existsSync(join(target, "node_modules")), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("the test command is detected from package.json, and a project without one says nothing", () => {
	assert.equal(detectTestCommand((p) => (p === "package.json" ? JSON.stringify({ scripts: { test: "node --test" } }) : undefined)), "npm test");
	assert.equal(detectTestCommand((p) => (p === "package.json" ? JSON.stringify({ scripts: { build: "tsc" } }) : undefined)), undefined);
	assert.equal(detectTestCommand((p) => (p === "package.json" ? JSON.stringify({ scripts: { test: "   " } }) : undefined)), undefined);
	assert.equal(detectTestCommand(() => undefined), undefined);
	assert.equal(detectTestCommand(() => "{not json"), undefined);
});

test("a worker's test verdict is read, and an unclear line is not a verdict", () => {
	assert.deepEqual(parseWorkerTests("TESTS: PASS all green"), { verdict: "PASS", detail: "all green" });
	assert.deepEqual(parseWorkerTests("TESTS: FAIL scheduler bound broke"), { verdict: "FAIL", detail: "scheduler bound broke" });
	assert.deepEqual(parseWorkerTests("TESTS: SKIP no test script"), { verdict: "SKIP", detail: "no test script" });
	assert.equal(parseWorkerTests("TESTS: maybe"), undefined);
	assert.equal(parseWorkerTests("no marker here"), undefined);
});

test("the coder is told the deps are ready, what to run, and to report both lines", () => {
	const prompt = buildCodeWorkerPrompt({ id: "s1", instruction: "add the bound" }, { worktreeDir: "/tmp/wt", scopes: ["src/a.ts"], testCommand: "npm test" });
	assert.match(prompt, /Dependencies are already available/);
	assert.match(prompt, /never run an install/);
	assert.match(prompt, /run `npm test`/);
	assert.match(prompt, /TESTS: PASS\|FAIL\|SKIP/);
	assert.match(prompt, /FILES:/);
	const noScript = buildCodeWorkerPrompt({ id: "s2", instruction: "x" }, { worktreeDir: "/tmp/wt", scopes: [] });
	assert.match(noScript, /whatever build\/test command this project uses/);
});
