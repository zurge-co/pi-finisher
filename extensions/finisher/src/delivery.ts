import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { finisherDir, statePath } from "./project-dir.ts";
import { excludeFromGitStatus, GIT_TIMEOUT_MS, gitOk, linkDeps } from "./worktree.ts";

export const DELIVERY_FILE = "delivery.json";
export const DELIVERY_KEEP = 3;
export const DELIVERY_BRANCH_PREFIX = "finisher/swarm/";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface DeliveryRun {
	runId: string;
	branch: string;
	worktreeDir: string;
	baseHead?: string;
	at: number;
	applied?: string[];
}

export interface DeliveryPlan {
	runId: string;
	branch: string;
	worktreeDir: string;
}

export const deliveryBranch = (runId: string): string => `${DELIVERY_BRANCH_PREFIX}${runId}`;

export const deliveryRoot = (cwd: string): string => join(finisherDir(cwd), "worktree", "delivery");

export const planDelivery = (cwd: string, runId: string): DeliveryPlan => {
	if (!RUN_ID.test(runId) || runId.includes("..")) throw new Error(`unsafe delivery run id "${runId}" — use letters, digits, ".", "-" or "_"`);
	const root = deliveryRoot(cwd);
	const worktreeDir = join(root, runId);
	if (!worktreeDir.startsWith(`${root}${sep}`)) throw new Error(`delivery run ${runId} would escape ${root}`);
	return { runId, branch: deliveryBranch(runId), worktreeDir };
};

export const deliveryCommitMessage = (runId: string, id: string): string => `finisher ${runId}: slice ${id}`;

export const deliveryBaseHead = (cwd: string): string | undefined => {
	const r = gitOk(["rev-parse", "HEAD"], cwd);
	return r.ok && r.out.trim() ? r.out.trim() : undefined;
};

const branchExists = (cwd: string, branch: string): boolean => gitOk(["rev-parse", "--verify", "-q", branch], cwd).ok;

const gitInput = (args: string[], cwd: string, input: string): { ok: boolean; msg: string } => {
	try {
		execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
		return { ok: true, msg: "applied" };
	} catch (e: unknown) {
		const err = e as { stderr?: { toString(): string }; message?: string };
		return { ok: false, msg: (err?.stderr?.toString() ?? err?.message ?? String(e)).split("\n")[0] };
	}
};

const mergedIntoHead = (cwd: string, branch: string): boolean => (branchExists(cwd, branch) ? gitOk(["merge-base", "--is-ancestor", branch, "HEAD"], cwd).ok : true);

export const pruneDeliveries = (cwd: string, keep = DELIVERY_KEEP, protect?: string): string[] => {
	const root = deliveryRoot(cwd);
	let names: string[];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => String(entry.name))
			.sort();
	} catch {
		return [];
	}
	const kept = new Set(names.slice(Math.max(0, names.length - Math.max(1, keep))));
	if (protect) kept.add(protect);
	const removed: string[] = [];
	for (const name of names) {
		if (kept.has(name) || !RUN_ID.test(name)) continue;
		if (!mergedIntoHead(cwd, deliveryBranch(name))) continue;
		gitOk(["worktree", "remove", "--force", join(root, name)], cwd);
		gitOk(["branch", "-D", deliveryBranch(name)], cwd);
		removed.push(name);
	}
	if (removed.length) gitOk(["worktree", "prune"], cwd);
	return removed;
};

export const createDelivery = (cwd: string, runId: string, at = Date.now()): { ok: boolean; msg: string; delivery: DeliveryRun } => {
	const plan = planDelivery(cwd, runId);
	const baseHead = deliveryBaseHead(cwd);
	const delivery: DeliveryRun = { ...plan, at, ...(baseHead ? { baseHead } : {}) };
	mkdirSync(dirname(plan.worktreeDir), { recursive: true });
	const add = branchExists(cwd, plan.branch)
		? gitOk(["worktree", "add", plan.worktreeDir, plan.branch], cwd)
		: gitOk(["worktree", "add", plan.worktreeDir, "-b", plan.branch], cwd);
	if (!add.ok) return { ok: false, msg: `could not create the delivery worktree ${plan.worktreeDir} (branch ${plan.branch}): ${add.err}`, delivery };
	excludeFromGitStatus(cwd, plan.worktreeDir);
	linkDeps(cwd, plan.worktreeDir);
	pruneDeliveries(cwd, DELIVERY_KEEP, runId);
	return { ok: true, msg: `${plan.worktreeDir} (branch ${plan.branch})`, delivery };
};

export const applyToDelivery = (worktreeDir: string, diff: string): { ok: boolean; msg: string } => {
	if (!diff.trim()) return { ok: true, msg: "no changes" };
	return gitInput(["apply", "--3way", "-"], worktreeDir, diff);
};

export const commitDelivery = (worktreeDir: string, message: string): { ok: boolean; msg: string; sha?: string } => {
	const add = gitOk(["add", "-A", "--", "."], worktreeDir);
	if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], worktreeDir).ok) return { ok: true, msg: "nothing to commit" };
	const commit = gitOk(["commit", "-q", "-m", message, "--no-verify"], worktreeDir);
	if (!commit.ok) return { ok: false, msg: commit.err };
	const sha = gitOk(["rev-parse", "--short", "HEAD"], worktreeDir);
	return { ok: true, msg: sha.ok ? sha.out.trim() : "committed", ...(sha.ok ? { sha: sha.out.trim() } : {}) };
};

export const deliverSlice = (delivery: DeliveryRun, id: string, diff: string): { ok: boolean; msg: string; sha?: string } => {
	const applied = applyToDelivery(delivery.worktreeDir, diff);
	if (!applied.ok) return { ok: false, msg: `the slice's patch did not apply to the delivery worktree: ${applied.msg}` };
	return commitDelivery(delivery.worktreeDir, deliveryCommitMessage(delivery.runId, id));
};

export const deliveryPath = (cwd: string): string => statePath(cwd, DELIVERY_FILE);

const validDelivery = (raw: unknown): DeliveryRun | undefined => {
	const d = raw as Partial<DeliveryRun> | undefined;
	if (!d || typeof d !== "object") return undefined;
	const { runId, branch, worktreeDir } = d;
	if (typeof runId !== "string" || !RUN_ID.test(runId)) return undefined;
	if (typeof branch !== "string" || !branch.startsWith(DELIVERY_BRANCH_PREFIX)) return undefined;
	if (typeof worktreeDir !== "string" || !worktreeDir.trim() || /[\r\n]/.test(worktreeDir)) return undefined;
	const at = Number(d.at);
	return {
		runId,
		branch,
		worktreeDir,
		at: Number.isFinite(at) ? at : 0,
		...(typeof d.baseHead === "string" && d.baseHead ? { baseHead: d.baseHead } : {}),
		...(Array.isArray(d.applied) ? { applied: d.applied.filter((p): p is string => typeof p === "string") } : {}),
	};
};

export const readDelivery = (cwd: string): DeliveryRun | undefined => {
	try {
		const path = deliveryPath(cwd);
		if (!existsSync(path)) return undefined;
		return validDelivery(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
};

export const writeDelivery = (cwd: string, delivery: DeliveryRun): boolean => {
	try {
		const path = deliveryPath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(delivery)}\n`);
		return true;
	} catch {
		return false;
	}
};

export const clearDelivery = (cwd: string): void => {
	try {
		rmSync(deliveryPath(cwd), { force: true });
	} catch {
	}
};

export const liveDelivery = (delivery: DeliveryRun | undefined): DeliveryRun | undefined => (delivery && existsSync(delivery.worktreeDir) ? delivery : undefined);

export const deliveryCheckRoot = (cwd: string): string => liveDelivery(readDelivery(cwd))?.worktreeDir ?? cwd;

export const mergeCommand = (delivery: DeliveryRun): string => `git merge --no-ff ${delivery.branch}`;

export const removeCommand = (delivery: DeliveryRun): string => `git worktree remove --force ${delivery.worktreeDir} && git branch -d ${delivery.branch}`;

export const removeDelivery = (cwd: string, delivery: DeliveryRun): { ok: boolean; msg: string } => {
	const removed = gitOk(["worktree", "remove", "--force", delivery.worktreeDir], cwd);
	if (!removed.ok) return { ok: false, msg: `could not remove ${delivery.worktreeDir}: ${removed.err}` };
	clearDelivery(cwd);
	const branch = gitOk(["branch", "-d", delivery.branch], cwd);
	return { ok: true, msg: branch.ok ? `${delivery.worktreeDir} removed, ${delivery.branch} deleted` : `${delivery.worktreeDir} removed; ${delivery.branch} kept (${branch.err})` };
};

export const deliveryAdvice = (cwd: string, delivery: DeliveryRun): string[] => [
	`delivery worktree: ${delivery.worktreeDir} (branch ${delivery.branch})`,
	`the workspace ${cwd} is untouched — nothing was merged into it and nothing will be unless the human says so`,
	`merge it only when the human asks (merge / lgtm / เอาเลย): ${mergeCommand(delivery)}`,
	`then remove the checkout: ${removeCommand(delivery)}`,
];
