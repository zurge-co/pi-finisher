import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changePathsSince,
	commitWorkingTree,
	composeCommitMessage,
	discardSinceBaseline,
	headOf,
	isGitRepo,
	sanitizeSubject,
	uncommittedChanges,
} from "../extensions/finisher/index.ts";

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "finisher-cycle-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "README.md"), "# init\n");
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "state"), "harness\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { base, cwd, git };
};

test("the cycle baseline is a commit sha, and no worktree is created to hold the work", () => {
	const { base, cwd, git } = makeRepo();
	try {
		assert.equal(isGitRepo(cwd), true);
		const baseline = headOf(cwd);
		assert.match(baseline ?? "", /^[0-9a-f]{40}$/);
		assert.deepEqual(changePathsSince(cwd, baseline), [], "a fresh cycle starts with no changes");
		writeFileSync(join(cwd, "new.txt"), "x\n");
		writeFileSync(join(cwd, "README.md"), "# changed\n");
		assert.deepEqual(changePathsSince(cwd, baseline).sort(), ["README.md", "new.txt"], "tracked edits and new files both count");
		assert.equal(git(["worktree", "list"], cwd) && true, true);
		assert.equal(readFileSync(join(cwd, "new.txt"), "utf8"), "x\n", "the agent's file is in the real repo, not a hidden checkout");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discard rolls the cycle back to its baseline and removes files the cycle created", () => {
	const { base, cwd, git } = makeRepo();
	try {
		const baseline = headOf(cwd);
		writeFileSync(join(cwd, "README.md"), "# agent edit\n");
		writeFileSync(join(cwd, "added.txt"), "new\n");
		git(["add", "added.txt"]);
		const r = discardSinceBaseline(cwd, baseline);
		assert.equal(r.ok, true, r.msg);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "# init\n", "the edited file is back to baseline");
		assert.equal(changePathsSince(cwd, baseline).length, 0, "nothing is left changed");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discard refuses without a baseline instead of guessing what to delete", () => {
	const { base, cwd } = makeRepo();
	try {
		const r = discardSinceBaseline(cwd, undefined);
		assert.equal(r.ok, false);
		assert.match(r.msg, /no baseline/);
		assert.deepEqual(r.paths, []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("discard on a clean cycle is a no-op rather than a destructive reset", () => {
	const { base, cwd } = makeRepo();
	try {
		const r = discardSinceBaseline(cwd, headOf(cwd));
		assert.equal(r.ok, true);
		assert.match(r.msg, /nothing changed/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("the harness state directory is never part of what a cycle sees or reverts", () => {
	const { base, cwd } = makeRepo();
	try {
		const baseline = headOf(cwd);
		writeFileSync(join(cwd, ".finisher", "spec.json"), "{}");
		assert.deepEqual(changePathsSince(cwd, baseline), [], ".finisher is excluded by construction");
		assert.equal(discardSinceBaseline(cwd, baseline).ok, true);
		assert.ok(readFileSync(join(cwd, ".finisher", "spec.json"), "utf8").length > 0, "discard must not eat harness state");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("accept can commit the cycle's work, and says so honestly when there is nothing to commit", () => {
	const { base, cwd } = makeRepo();
	try {
		const spec = { version: 2, title: "do the thing", intent: "why it matters", scope: [], criteria: [], specDebt: [], approved: true };
		writeFileSync(join(cwd, "work.txt"), "done\n");
		const r = commitWorkingTree(cwd, composeCommitMessage(spec));
		assert.equal(r.ok, true, r.msg);
		assert.match(r.sha ?? "", /^[0-9a-f]+$/);
		assert.equal(headOf(cwd), execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim());
		const again = commitWorkingTree(cwd, composeCommitMessage(spec));
		assert.equal(again.ok, true);
		assert.equal(again.msg, "nothing to commit", "a second accept must not invent a commit");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("the commit message is one bounded subject line and carries the spec's reason", () => {
	const long = "a very long title ".repeat(10);
	assert.ok(sanitizeSubject(long).length <= 72);
	assert.equal(sanitizeSubject("   "), "finisher impl");
	const msg = composeCommitMessage({ version: 3, title: "t", intent: "because reasons", scope: [], criteria: [], specDebt: [], approved: true });
	assert.match(msg, /^t\n/);
	assert.match(msg, /because reasons/);
	assert.match(msg, /finisher spec v3/);
});

test("uncommittedChanges reports the repo but never the harness state", () => {
	const { base, cwd } = makeRepo();
	try {
		assert.deepEqual(uncommittedChanges(cwd), []);
		writeFileSync(join(cwd, "x.txt"), "x\n");
		writeFileSync(join(cwd, ".finisher", "noise"), "n\n");
		const lines = uncommittedChanges(cwd);
		assert.equal(lines.length, 1, `expected only the repo file, got ${lines.join(" | ")}`);
		assert.match(lines[0], /x\.txt/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
