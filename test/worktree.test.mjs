import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, appendFileSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	rewritePathForWorktree,
	buildWorktreeCommand,
	createWorktree,
	applyWorktreeBack,
	discardPendingApply,
	acceptPendingApply,
	composeCommitMessage,
	sanitizeSubject,
	gitOk,
} from "../extensions/zense-harness/index.ts";

test("rewritePathForWorktree: relative path under the repo → remapped under wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "extensions/x.ts"), "/r-wt/extensions/x.ts");
});

test("rewritePathForWorktree: absolute path under cwd → remapped under wtRoot", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/a/b.ts"), "/r-wt/a/b.ts");
});

test("rewritePathForWorktree: path outside the repo (absolute, not under cwd) → unchanged", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/Users/elsewhere/doc.md"), "/Users/elsewhere/doc.md");
});

test("rewritePathForWorktree: relative escape (../) → not under wtRoot", () => {
	const out = rewritePathForWorktree("/r/sub", "/r/sub-wt", "../outside.txt");
	assert.ok(!out.startsWith("/r/sub-wt"), `expected not under wtRoot, got ${out}`);
});

test("rewritePathForWorktree: path under .zense/ → unchanged (harness state lives in main)", () => {
	assert.equal(rewritePathForWorktree("/r", "/r-wt", ".zense/spec.md"), ".zense/spec.md");
	assert.equal(rewritePathForWorktree("/r", "/r-wt", "/r/.zense/memory.jsonl"), "/r/.zense/memory.jsonl");
});

test("buildWorktreeCommand: prefixed with cd <wtRoot> && (spacey paths single-quoted)", () => {
	assert.equal(buildWorktreeCommand("npm test", "/r-wt"), "cd '/r-wt' && npm test");
	assert.equal(buildWorktreeCommand("ls", "/path with space/wt"), "cd '/path with space/wt' && ls");
});

const SPEC = {
	version: 1,
	title: "Add src module",
	intent: "Implement the src module for testing apply-back.",
	scope: [],
	constraints: [],
	criteria: [],
	specDebt: [],
	approved: true,
};

const gitIn = (dir) => (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
	writeFileSync(join(cwd, ".zense", "x"), "x"); 	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { cwd, base, git };
};

const stagedIn = (git) => git(["diff", "--cached", "--name-only", "--", ".", ":!.zense"]).split("\n").map((s) => s.trim()).filter(Boolean);

test("gitOk: returns ok=false in a non-git dir", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit-"));
	const r = gitOk(["status"], base);
	assert.equal(r.ok, false);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: creates the worktree + a zense/impl/* branch + copies spec.json in", () => {
	const { cwd, base, git } = makeRepo();
	writeFileSync(join(cwd, ".zense", "spec.json"), '{"version":1}');
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.ok(wt.branch.startsWith("zense/impl/v1-"), `branch=${wt.branch}`);
		assert.equal(
		join(cwd, ".zense", "worktree"),
		dirname(wt.root),
		`worktree parent should be .zense/worktree, got ${wt.root}`,
	);
	assert.ok(basename(wt.root).startsWith("repo-wt-"), `wt name keeps repo basename: ${wt.root}`);
	assert.ok(existsSync(join(wt.root, "README.md")), "worktree has checked-out file");
	assert.ok(existsSync(join(wt.root, ".zense", "spec.json")), "spec.json copied into worktree");
	const list = git(["worktree", "list"]);
	assert.ok(list.includes(wt.root), "worktree listed by git");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: main repo git status stays clean (nested worktree excluded via .git/info/exclude)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	assert.equal(git(["status", "--porcelain"]).trim(), "", "main git status should be clean");
		const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
	assert.ok(exclude.includes("/.zense/worktree/"), `exclude has worktree path: ${exclude}`);
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: captures baseline ref (main HEAD before branch)", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt, "worktree should be created");
	assert.equal(wt.baseline, headBefore, "baseline = main HEAD right before branching");
	rmSync(base, { recursive: true, force: true });
});

test("createWorktree: in a non-git dir → null, no throw", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-nogit2-"));
	const wt = createWorktree(base, SPEC);
	assert.equal(wt, null);
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: eval PASS → change staged in main, HEAD unmoved (no new commit) + worktree/branch cleaned + reverse patch stored", () => {
	const { cwd, base, git } = makeRepo();
	const headBefore = git(["rev-parse", "HEAD"]).trim();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
		writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
		assert.equal(git(["rev-parse", "HEAD"]).trim(), headBefore, "HEAD must not move (no auto-commit)");
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged");
		assert.deepEqual(stagedIn(git), ["src.txt"], "src.txt staged in main");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "impl\n");
	assert.deepEqual(ar.paths, ["src.txt"]);
		assert.ok(ar.commitMsg.includes("Add src module"), `commitMsg has spec title: ${ar.commitMsg}`);
		assert.ok(readFileSync(join(cwd, ".zense", "pending-apply.patch"), "utf8").includes("src.txt"), "reverse patch stored");
		assert.ok(!existsSync(wt.root), "worktree dir removed");
	assert.equal(git(["branch", "--list", wt.branch]).trim(), "", "branch deleted");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: several interim commits + an uncommitted file → squashed and fully staged in main (log unmoved)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const gwt = gitIn(wt.root);
	writeFileSync(join(wt.root, "a.txt"), "a\n");
	gwt(["add", "a.txt"]);
	gwt(["commit", "-q", "-m", "wip: add a"]);
	writeFileSync(join(wt.root, "b.txt"), "b\n");
	gwt(["add", "b.txt"]);
	gwt(["commit", "-q", "-m", "wip: add b"]);
	writeFileSync(join(wt.root, "c.txt"), "c\n"); 	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
		assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged (no interim, no merge commit)");
		assert.deepEqual(stagedIn(git).sort(), ["a.txt", "b.txt", "c.txt"], "all files staged");
		assert.ok(ar.commitMsg.includes("wip: add a") && ar.commitMsg.includes("wip: add b"), `commitMsg lists interims: ${ar.commitMsg}`);
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: unchanged worktree → ok=true with empty paths, main clean, fully cleaned up", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed: ${ar.msg}`);
	assert.deepEqual(ar.paths, [], "no paths staged");
	assert.deepEqual(stagedIn(git), [], "nothing staged in main");
	assert.deepEqual(git(["log", "--format=%s"]).trim().split("\n"), ["init"], "main log unchanged");
	assert.ok(!existsSync(wt.root), "worktree cleaned up");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: repo gitignoring .zense/ — worktree staging must not fail (git ≥2.55 exclude-pathspec regression) + .zense never follows into main", () => {
	const base = mkdtempSync(join(tmpdir(), "zense-wt-ignored-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = gitIn(cwd);
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, ".gitignore"), ".zense/\n"); 	writeFileSync(join(cwd, "README.md"), "# init\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, ".zense", "spec.json"), "{}\n"); 	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply must succeed despite .zense being gitignored: ${ar.msg}`);
	assert.deepEqual(stagedIn(git), ["src.txt"], "only sources staged — harness state stays behind");
	assert.ok(!existsSync(wt.root), "worktree cleaned up");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: dirty-main guard — uncommitted changes outside .zense → refuse (ok=false dirtyMain), branch/worktree untouched", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
		writeFileSync(join(cwd, "README.md"), "# human change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false, `apply should be refused: ${ar.msg}`);
	assert.equal(ar.dirtyMain, true, "flagged as dirtyMain");
		assert.ok(existsSync(wt.root), "worktree kept");
	assert.ok(git(["branch", "--list", wt.branch]).trim(), "branch kept");
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# human change\n");
	assert.deepEqual(stagedIn(git), [], "nothing staged by failed apply");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: the guard ignores .zense — dirty .zense in main doesn't block apply (policy)", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
		appendFileSync(join(cwd, ".zense", "x"), "state-dirty");
	writeFileSync(join(cwd, ".zense", "memory.jsonl"), "{}\n"); 	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true, `apply should succeed despite dirty .zense: ${ar.msg}`);
	assert.deepEqual(stagedIn(git), ["src.txt"]);
		assert.equal(readFileSync(join(cwd, ".zense", "memory.jsonl"), "utf8"), "{}\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: conflict (another session edited the same file in main) → ok=false conflict=true, main rolled back clean, worktree kept", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
		writeFileSync(join(cwd, "src.txt"), "main-change\n");
	git(["add", "src.txt"]);
	git(["commit", "-q", "-m", "other session"]);
		writeFileSync(join(wt.root, "src.txt"), "wt-change\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, false);
	assert.equal(ar.conflict, true);
		assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean after abort");
	assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "main-change\n");
		assert.ok(existsSync(wt.root), "worktree kept for manual resolve");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: no .zense changes in the staged result (harness state never follows into main) — via both staging and interim commits in the worktree", () => {
	const { cwd, base, git } = makeRepo();
		mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "spec.md"), "# old\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "add spec"]);
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	const gwt = gitIn(wt.root);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	gwt(["add", "src.txt"]);
	gwt(["commit", "-q", "-m", "wip: src"]);
	writeFileSync(join(wt.root, ".zense", "spec.md"), "# new\n");
	gwt(["add", ".zense/spec.md"]);
	gwt(["commit", "-q", "-m", "wip: zense state"]);
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
		const staged = stagedIn(git);
	assert.ok(!staged.some((p) => p.startsWith(".zense")), `no .zense in staged: ${staged}`);
	assert.deepEqual(staged, ["src.txt"]);
		assert.equal(readFileSync(join(cwd, ".zense", "spec.md"), "utf8"), "# old\n");
	rmSync(base, { recursive: true, force: true });
});

test("applyWorktreeBack: multi-session — A's apply sits staged, B applies after → the guard must refuse (mixing is the only alternative)", () => {
	const { cwd, base, git } = makeRepo();
		const wtA = createWorktree(cwd, SPEC);
	assert.ok(wtA);
	writeFileSync(join(wtA.root, "a.txt"), "a\n");
	const arA = applyWorktreeBack(cwd, SPEC, wtA);
	assert.equal(arA.ok, true);
		const specB = { ...SPEC, version: 2, title: "Add b module" };
	const wtB = createWorktree(cwd, specB);
	assert.ok(wtB);
	writeFileSync(join(wtB.root, "b.txt"), "b\n");
	const arB = applyWorktreeBack(cwd, specB, wtB);
	assert.equal(arB.ok, false, "B must be refused while A's staged changes pending");
	assert.equal(arB.dirtyMain, true);
	assert.ok(existsSync(wtB.root), "B worktree kept");
		assert.deepEqual(stagedIn(git), ["a.txt"]);
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: rolls back the applied change → new files removed, main exactly back to its pre-apply state", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	appendFileSync(join(wt.root, "README.md"), "added-line\n"); 	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
		const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
		assert.ok(!existsSync(join(cwd, "src.txt")), "new file removed by reverse patch");
	assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# init\n", "tracked file restored");
	assert.equal(git(["status", "--porcelain", "--", ".", ":!.zense"]).trim(), "", "main clean as before apply");
		assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: human edited the applied files → reverse fails loudly and never deletes human work", () => {
	const { cwd, base, git } = makeRepo();
	const wt = createWorktree(cwd, SPEC);
	assert.ok(wt);
	writeFileSync(join(wt.root, "src.txt"), "impl\n");
	const ar = applyWorktreeBack(cwd, SPEC, wt);
	assert.equal(ar.ok, true);
		writeFileSync(join(cwd, "src.txt"), "human edit\n");
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false, "reverse must fail when human edited applied files");
		assert.equal(readFileSync(join(cwd, "src.txt"), "utf8"), "human edit\n");
		assert.ok(existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch kept on failure");
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: no pending patch → ok=false without breaking anything", () => {
	const { cwd, base } = makeRepo();
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, false);
	assert.ok(dr.msg.includes("not found"), `msg explains: ${dr.msg}`);
	rmSync(base, { recursive: true, force: true });
});

test("discardPendingApply: empty patch (apply had no source change) → ok=true, unstage only, no breakage", () => {
	const { cwd, base, git } = makeRepo();
	mkdirSync(join(cwd, ".zense"), { recursive: true });
	writeFileSync(join(cwd, ".zense", "pending-apply.patch"), ""); 		writeFileSync(join(cwd, "leftover.txt"), "x\n");
	git(["add", "leftover.txt"]);
	const dr = discardPendingApply(cwd);
	assert.equal(dr.ok, true, `discard should succeed: ${dr.msg}`);
		assert.equal(git(["diff", "--cached", "--name-only"]).trim(), "", "index unstaged");
	assert.ok(!existsSync(join(cwd, ".zense", "pending-apply.patch")), "patch cleaned");
	rmSync(base, { recursive: true, force: true });
});

test("composeCommitMessage: single-line subject ≤72 chars + interim list + footer", () => {
	assert.equal(sanitizeSubject("hello   world\nsecond line"), "hello world second line");
	const long = "x".repeat(100);
	const s = sanitizeSubject(long);
	assert.ok(s.length <= 72, `subject ≤72: ${s.length}`);
	assert.ok(s.endsWith("…"), "long subject truncated with ellipsis");
	assert.equal(sanitizeSubject(""), "zense impl");
	const msg = composeCommitMessage(SPEC, ["wip: one", "wip: two"]);
	assert.ok(msg.startsWith("Add src module\n\n"), `subject first: ${msg}`);
	assert.ok(msg.includes("- wip: one") && msg.includes("- wip: two"), `lists interims: ${msg}`);
	assert.ok(msg.includes("zense spec v1"), `footer: ${msg}`);
	const bare = composeCommitMessage({ ...SPEC, intent: "" }, []);
	assert.ok(!bare.includes("Squashed"), "no interim section when empty");
});
