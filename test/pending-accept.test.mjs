import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptPendingApply } from "../extensions/zense-harness/index.ts";

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "zense-wt-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "x"), "x");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

const seedPending = ({ cwd, git }) => {
	writeFileSync(join(cwd, ".zense", "pending-apply.patch"), "dummy reverse patch\n");
	writeFileSync(join(cwd, ".zense", "pending-apply.msg"), "Add src module\n\nbody from composeCommitMessage\n");
	writeFileSync(join(cwd, "src.txt"), "from worktree\n");
	git(["add", "src.txt"]);
};

const pendingFiles = (cwd) => ({
	patch: existsSync(join(cwd, ".zense", "pending-apply.patch")),
	msg: existsSync(join(cwd, ".zense", "pending-apply.msg")),
});

test("acceptPendingApply: no pending patch → clear ok=false, repo untouched", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /no pending apply/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: the human committed themselves (empty index, HEAD moved) → ok, patch+msg removed, no warnings", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]); 	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, false);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: soft mode — empty index but HEAD unmoved (change vanished?) → still ok, warning attached, never refuses", () => {
	const { cwd, base, git } = makeRepo();
	const preApplyHead = git(["rev-parse", "HEAD"]).trim();
	seedPending({ cwd, git });
	git(["reset", "-q", "--hard", "HEAD"]); 	const r = acceptPendingApply(cwd, { preApplyHead });
	assert.equal(r.ok, true, "soft mode accepts even when suspect");
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /HEAD/);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: still staged + no commit-on-behalf requested → ok=false explaining both ways out", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const r = acceptPendingApply(cwd);
	assert.equal(r.ok, false);
	assert.match(r.msg, /commitIfStaged=true \/ \/zense accept commit/);
	assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "must never commit unprompted");
	assert.deepEqual(pendingFiles(cwd), { patch: true, msg: true }, "not yet accepted → patch+msg must remain");
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: commitIfStaged=true ('commit it for me') → commits with the prepared message, then clears patch+msg", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	const r = acceptPendingApply(cwd, { commitIfStaged: true });
	assert.equal(r.ok, true, r.msg);
	assert.equal(r.committedOnBehalf, true);
	assert.equal(git(["log", "-1", "--format=%s"]).trim(), "Add src module", "subject comes from pending-apply.msg");
		assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean), ["src.txt"]);
	assert.deepEqual(pendingFiles(cwd), { patch: false, msg: false });
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: human amendments — evalTree differs from HEAD^{tree} → returns only the human-edited files", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim(); 	writeFileSync(join(cwd, "src.txt"), "human tweak\n"); 	writeFileSync(join(cwd, "extra.md"), "human notes\n");
	git(["add", "src.txt", "extra.md"]);
	git(["commit", "-q", "-m", "human adjustments after review"]);
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles.sort(), ["extra.md", "src.txt"]);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: evalTree equals HEAD^{tree} (no human edits) → amendedFiles empty", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const evalTree = git(["rev-parse", "HEAD^{tree}"]).trim();
	const r = acceptPendingApply(cwd, { evalTree });
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});

test("acceptPendingApply: no evalTree → the delta is skipped quietly (amendedFiles empty)", () => {
	const { cwd, base, git } = makeRepo();
	seedPending({ cwd, git });
	git(["commit", "-q", "-F", join(cwd, ".zense", "pending-apply.msg")]);
	const r = acceptPendingApply(cwd, {});
	assert.equal(r.ok, true, r.msg);
	assert.deepEqual(r.amendedFiles, []);
	rmSync(base, { recursive: true, force: true });
});
