import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkFingerprint,
	createDelivery,
	deliverSlice,
	deliveryAdvice,
	deliveryBranch,
	deliveryCheckRoot,
	mergeCommand,
	planDelivery,
	planSlices,
	pruneDeliveries,
	readDelivery,
	removeDelivery,
	writeDelivery,
} from "../extensions/finisher/index.ts";

const makeRepo = () => {
	const base = mkdtempSync(join(tmpdir(), "finisher-delivery-"));
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	const git = (args, at = cwd) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["config", "user.email", "t@t"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(cwd, "a.txt"), "one\n");
	writeFileSync(join(cwd, "b.txt"), "bee\n");
	writeFileSync(join(cwd, "c.txt"), "sea\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	return { base, cwd, git };
};

const slicePatch = (base, git, id, file, text) => {
	const dir = join(base, `checkout-${id}`);
	git(["worktree", "add", dir, "-b", `checkout-${id}`]);
	writeFileSync(join(dir, file), text);
	git(["add", "-A"], dir);
	return git(["diff", "--cached", "HEAD"], dir);
};

const runIds = ["2026-02-06T09-00-00", "2026-02-06T09-00-01", "2027-11-30T23-59-59"];

test("no delivery run can ever share a checkout or a branch with a slice or another run", () => {
	const cwd = "/tmp/never-a-repo";
	const slices = planSlices([{ id: "s1", instruction: "x" }, { id: "s2", instruction: "y" }], "/tmp/run/swarm", runIds[0]);
	const taken = new Set(slices.flatMap((slice) => [slice.worktreeDir, slice.branch]));
	for (const runId of runIds) {
		const plan = planDelivery(cwd, runId);
		assert.equal(taken.has(plan.worktreeDir), false, `${plan.worktreeDir} collides with a slice checkout`);
		assert.equal(taken.has(plan.branch), false, `${plan.branch} collides with a slice branch`);
		assert.equal(plan.branch, deliveryBranch(runId));
		taken.add(plan.worktreeDir);
		taken.add(plan.branch);
	}
	assert.equal(new Set(runIds.map((id) => planDelivery(cwd, id).worktreeDir)).size, runIds.length, "two runs never deliver into one checkout");
	for (const bad of ["", ".", "..", "../escape", "a/b", "-rf", "x".repeat(65)]) assert.throws(() => planDelivery(cwd, bad), `run id ${JSON.stringify(bad)} must be refused`);
});

test("a slice's work lands in the delivery checkout, and the workspace it was written against stays byte-identical", () => {
	const { base, cwd, git } = makeRepo();
	try {
		const built = createDelivery(cwd, runIds[0]);
		assert.equal(built.ok, true, built.msg);
		const delivered = deliverSlice(built.delivery, "s1", slicePatch(base, git, "s1", "a.txt", "one\ntwo\n"));
		assert.equal(delivered.ok, true, delivered.msg);
		assert.equal(git(["status", "--porcelain"]).trim(), "", "the workspace is untouched: nothing was merged into it");
		assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\n", "the workspace still holds the pre-delivery tree");
		assert.equal(readFileSync(join(built.delivery.worktreeDir, "a.txt"), "utf8"), "one\ntwo\n", "the change lives only in the delivery checkout");
		assert.equal(git(["rev-list", "--count", `HEAD..${built.delivery.branch}`]).trim(), "1", "the delivery branch is one commit on top of the base");
		writeDelivery(cwd, { ...built.delivery, applied: ["s1"] });
		assert.equal(readDelivery(cwd)?.branch, built.delivery.branch);
		const advice = deliveryAdvice(cwd, built.delivery).join("\n");
		assert.ok(advice.includes(mergeCommand(built.delivery)), "the advice names the command that merges it");
		assert.match(advice, /untouched/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a patch that cannot apply commits nothing, so a failed slice never leaves a half-delivery", () => {
	const { base, cwd, git } = makeRepo();
	try {
		const built = createDelivery(cwd, runIds[1]);
		const baseHead = git(["rev-parse", "HEAD"]).trim();
		const impossible = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,1 +1,1 @@", "-nothing like this line", "+and nothing like this either", ""].join("\n");
		const failed = deliverSlice(built.delivery, "s9", impossible);
		assert.equal(failed.ok, false, "an unapplicable patch is a failure, never a silent success");
		assert.equal(git(["rev-parse", "HEAD"], built.delivery.worktreeDir).trim(), baseHead, "the delivery branch did not move");
		assert.equal(git(["status", "--porcelain"], built.delivery.worktreeDir).trim(), "", "no half-applied file was left behind");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("verify looks where the work is: the delivery checkout while it lives, the workspace once it is gone", () => {
	const { base, cwd, git } = makeRepo();
	try {
		assert.equal(deliveryCheckRoot(cwd), cwd, "no delivery means the workspace is the check root");
		const built = createDelivery(cwd, runIds[2]);
		writeDelivery(cwd, built.delivery);
		assert.equal(deliveryCheckRoot(cwd), built.delivery.worktreeDir);
		assert.notEqual(checkFingerprint(built.delivery.worktreeDir, 1), checkFingerprint(cwd, 1), "evidence recorded in one root can never prove the other");
		assert.equal(deliverSlice(built.delivery, "s1", slicePatch(base, git, "s1", "b.txt", "bee\nz\n")).ok, true);
		git(["merge", "--no-ff", built.delivery.branch]);
		assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "bee\nz\n", "the human's merge is what lands the work");
		const removed = removeDelivery(cwd, built.delivery);
		assert.equal(removed.ok, true, removed.msg);
		assert.equal(existsSync(built.delivery.worktreeDir), false);
		assert.equal(deliveryCheckRoot(cwd), cwd, "a delivery that is gone falls back to the workspace");
		assert.equal(readDelivery(cwd), undefined, "and its pointer is gone with it");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("pruning cleans a merged delivery and never deletes one the branch has not taken yet", () => {
	const { base, cwd, git } = makeRepo();
	try {
		const [first, second, third] = runIds.map((runId) => createDelivery(cwd, runId).delivery);
		assert.equal(deliverSlice(first, "s1", slicePatch(base, git, "s1", "a.txt", "one\ntwo\n")).ok, true);
		git(["merge", "--no-ff", first.branch]);
		assert.equal(deliverSlice(second, "s2", slicePatch(base, git, "s2", "b.txt", "bee\nz\n")).ok, true);
		assert.equal(deliverSlice(third, "s3", slicePatch(base, git, "s3", "c.txt", "sea\nq\n")).ok, true);
		assert.deepEqual(pruneDeliveries(cwd, 1, third.runId), [first.runId], "only the delivery the branch already took may be pruned");
		assert.equal(existsSync(second.worktreeDir), true, "unmerged work is never deleted");
		assert.match(git(["rev-parse", "--verify", "-q", second.branch]).trim(), /^[0-9a-f]{40}$/, "and its branch survives too");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
