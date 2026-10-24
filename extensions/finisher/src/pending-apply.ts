import { gitOk } from "./worktree.ts";
import { type Spec } from "./types.ts";

export const HARNESS_STATE_EXCLUDE = ":!.finisher";

export const sanitizeSubject = (title: string): string => {
	const oneLine = (title || "").replace(/\s+/g, " ").trim();
	if (!oneLine) return "finisher impl";
	return oneLine.length <= 72 ? oneLine : oneLine.slice(0, 71).trimEnd() + "…";
};

export const isGitRepo = (cwd: string): boolean => gitOk(["rev-parse", "--is-inside-work-tree"], cwd).ok;

export const uncommittedChanges = (cwd: string): string[] => {
	const r = gitOk(["status", "--porcelain", "--", ".", HARNESS_STATE_EXCLUDE], cwd);
	if (!r.ok) return [];
	return r.out.split("\n").map((s) => s.trimEnd()).filter(Boolean);
};

export const headOf = (cwd: string): string | undefined => {
	const r = gitOk(["rev-parse", "HEAD"], cwd);
	return r.ok ? r.out.trim() : undefined;
};

export const changePathsSince = (cwd: string, baseline?: string): string[] => {
	const args = baseline ? ["diff", "--name-only", baseline, "--", ".", HARNESS_STATE_EXCLUDE] : ["diff", "--name-only", "--", ".", HARNESS_STATE_EXCLUDE];
	const tracked = gitOk(args, cwd);
	const untracked = gitOk(["ls-files", "--others", "--exclude-standard", "--", ".", HARNESS_STATE_EXCLUDE], cwd);
	const all = [tracked.ok ? tracked.out : "", untracked.ok ? untracked.out : ""].join("\n");
	return all.split("\n").map((s) => s.trim()).filter((s, i, arr) => !!s && arr.indexOf(s) === i);
};

export const composeCommitMessage = (spec: Spec): string => {
	const subject = sanitizeSubject(spec.title || `finisher impl v${spec.version}`);
	const body = spec.intent?.trim() ? [spec.intent.trim()] : [];
	body.push(`finisher spec v${spec.version}`);
	return `${subject}\n\n${body.join("\n\n")}\n`;
};

export interface CommitResult {
	ok: boolean;
	msg: string;
	sha?: string;
}

export const commitWorkingTree = (cwd: string, message: string): CommitResult => {
	const add = gitOk(["add", "-A", "--", ".", HARNESS_STATE_EXCLUDE], cwd);
	if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], cwd).ok) return { ok: true, msg: "nothing to commit" };
	const cm = gitOk(["commit", "-m", message, "--no-verify"], cwd);
	if (!cm.ok) return { ok: false, msg: cm.err };
	const sha = gitOk(["rev-parse", "--short", "HEAD"], cwd);
	return { ok: true, msg: sha.ok ? sha.out.trim() : "committed", ...(sha.ok ? { sha: sha.out.trim() } : {}) };
};

export interface DiscardResult {
	ok: boolean;
	msg: string;
	paths: string[];
}

export const discardSinceBaseline = (cwd: string, baseline?: string): DiscardResult => {
	if (!baseline) return { ok: false, msg: "no baseline for this cycle — nothing to roll back to (start the work again from a confirmed goal)", paths: [] };
	const paths = changePathsSince(cwd, baseline);
	if (!paths.length) return { ok: true, msg: "nothing changed since the cycle started — already clean", paths: [] };
	const existedAtBaseline = paths.filter((p) => gitOk(["cat-file", "-e", `${baseline}:${p}`], cwd).ok);
	const bornThisCycle = paths.filter((p) => !existedAtBaseline.includes(p));
	if (existedAtBaseline.length) {
		const restore = gitOk(["checkout", baseline, "--", ...existedAtBaseline], cwd);
		if (!restore.ok) return { ok: false, msg: `git checkout failed: ${restore.err}`, paths };
	}
	if (bornThisCycle.length) {
		gitOk(["reset", "-q", "HEAD", "--", ...bornThisCycle], cwd);
		gitOk(["clean", "-fdx", "--", ...bornThisCycle], cwd);
	}
	const remaining = changePathsSince(cwd, baseline);
	return {
		ok: remaining.length === 0,
		msg: remaining.length ? `rolled back ${paths.length - remaining.length} path(s); ${remaining.length} still differ (inspect with git status)` : `rolled back ${paths.length} path(s) to ${baseline.slice(0, 12)}`,
		paths,
	};
};

export const applyResultPaths = changePathsSince;
