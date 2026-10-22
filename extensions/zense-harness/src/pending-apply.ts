
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Spec, type Worktree } from "./types.ts";
import { gitOk } from "./worktree.ts";

export const sanitizeSubject = (title: string): string => {
	const oneLine = (title || "").replace(/\s+/g, " ").trim();
	if (!oneLine) return "zense impl";
	return oneLine.length <= 72 ? oneLine : oneLine.slice(0, 71).trimEnd() + "…";
};

export const composeCommitMessage = (spec: Spec, interimSubjects: string[]): string => {
	const subject = sanitizeSubject(spec.title || `zense impl v${spec.version}`);
	const body: string[] = [];
	if (spec.intent?.trim()) body.push(spec.intent.trim());
	if (interimSubjects.length) body.push(`Squashed interim commits:\n${interimSubjects.map((s) => `- ${s}`).join("\n")}`);
	body.push(`zense spec v${spec.version} — eval PASS`);
	return `${subject}\n\n${body.join("\n\n")}\n`;
};

export const PENDING_PATCH = "pending-apply.patch"; export const PENDING_MSG = "pending-apply.msg";     export const NOT_ZENSE = ":!.zense";
export const isGitRepo = (cwd: string): boolean => gitOk(["rev-parse", "--is-inside-work-tree"], cwd).ok;

export const uncommittedChanges = (cwd: string): string[] => {
	const r = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], cwd);
	if (!r.ok) return [];
	return r.out.split("\n").map((s) => s.trimEnd()).filter(Boolean);
};

export const composeSnapshotMessage = (dirty: string[]): string => {
	const names = dirty.map((l) => l.slice(3).replace(/^"|"$/g, "")).filter(Boolean); 			let subject = "";
	for (let take = Math.min(3, names.length); take >= 0 && !subject; take--) {
		const more = names.length > take ? ` (+${names.length - take})` : "";
		const cand = sanitizeSubject(`chore: snapshot pre-spec${take ? `: ${names.slice(0, take).join(", ")}${more}` : more ? ` (${names.length} files)` : ""}`);
		if (!cand.endsWith("…") || take === 0) subject = cand; 	}
	return `${subject}\n\nFiles snapshotted (uncommitted at pre-spec check):\n${names.map((n) => `- ${n}`).join("\n")}\n`;
};

export const gitAddButZense = (cwd: string): { ok: boolean; out: string; err: string } => {
	const add = gitOk(["add", "-A", "--", "."], cwd);
	if (!add.ok) return add;
	const head = gitOk(["rev-parse", "--verify", "-q", "HEAD"], cwd);
	if (head.ok) gitOk(["reset", "-q", "--", ".zense"], cwd); 	else gitOk(["rm", "-r", "--cached", "-q", "--ignore-unmatch", ".zense"], cwd); 	return add;
};

export const snapshotUncommitted = (cwd: string, message: string): { ok: boolean; msg: string } => {
	const add = gitAddButZense(cwd);
		if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], cwd).ok) return { ok: true, msg: "nothing to commit" };
	const cm = gitOk(["commit", "-m", message, "--no-verify"], cwd);
	if (!cm.ok) return { ok: false, msg: cm.err };
	const h = gitOk(["rev-parse", "--short", "HEAD"], cwd);
	return { ok: true, msg: h.ok ? h.out.trim() : "committed" };
};

export interface ApplyBackResult {
	ok: boolean;
	conflict?: boolean;   	dirtyMain?: boolean;  	msg: string;
	paths: string[];      	commitMsg?: string;   }

export const applyWorktreeBack = (cwd: string, spec: Spec, wt: Worktree): ApplyBackResult => {
		const dirty = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], cwd);
	if (dirty.ok && dirty.out.trim())
		return {
			ok: false,
			dirtyMain: true,
			paths: [],
			msg: `main has uncommitted changes outside .zense/ — not applying (mixed changes make undo hard): commit/stash them first, then re-eval\n${dirty.out.trim().split("\n").slice(0, 10).join("\n")}`,
		};
		const mb = gitOk(["merge-base", wt.branch, "HEAD"], cwd);
	const base = mb.ok ? mb.out.trim() : "";
	const interimSubjects = base ? gitOk(["log", "--format=%s", `${base}..HEAD`], wt.root).out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
			gitAddButZense(wt.root);
	if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
		gitOk(["commit", "-m", "(interim — squashed at apply-back)", "--no-verify"], wt.root);
	}
	const ahead = base ? Number(gitOk(["rev-list", "--count", `${base}..HEAD`], wt.root).out.trim() || "0") : 0;
	if (base && ahead > 0) {
		gitOk(["reset", "--soft", base], wt.root); 		gitOk(["reset", "-q", "HEAD", "--", ".zense"], wt.root); 		if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
			gitOk(["commit", "-m", composeCommitMessage(spec, interimSubjects), "--no-verify"], wt.root);
		} else {
						gitOk(["reset", "--hard", base], wt.root);
		}
	} else if (!gitOk(["diff", "--cached", "--quiet"], wt.root).ok) {
				gitOk(["commit", "-m", composeCommitMessage(spec, []), "--no-verify"], wt.root);
	}
		const branchMsg = gitOk(["log", "-1", "--format=%B", wt.branch], cwd);
	const commitMsg = branchMsg.ok && branchMsg.out.trim() ? branchMsg.out.trim() + "\n" : composeCommitMessage(spec, interimSubjects);
		if (!gitOk(["merge", "--squash", wt.branch], cwd).ok) {
						gitOk(["reset", "-q", "HEAD", "--", ".", NOT_ZENSE], cwd);
		gitOk(["restore", "--staged", "--worktree", "--source=HEAD", "--", ".", NOT_ZENSE], cwd);
		gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], cwd);
		return { ok: false, conflict: true, paths: [], msg: `apply conflict — main was rolled back; fix manually: cd ${wt.root}, resolve/commit on branch ${wt.branch}, then git merge --squash ${wt.branch} in main` };
	}
		const paths = gitOk(["diff", "--cached", "--name-only", "--", ".", NOT_ZENSE], cwd).out.split("\n").map((s) => s.trim()).filter(Boolean);
	const patch = gitOk(["diff", "--cached", "--binary", "--", ".", NOT_ZENSE], cwd);
	mkdirSync(zenseDir(cwd), { recursive: true });
	writeFileSync(join(zenseDir(cwd), PENDING_PATCH), patch.ok ? patch.out : "");
		gitOk(["worktree", "remove", wt.dir, "--force"], cwd);
	gitOk(["branch", "-D", wt.branch], cwd);
	return { ok: true, paths, commitMsg, msg: `applied ${wt.branch} → main (staged, uncommitted — spec v${spec.version}; human commits after review)` };
};

export const discardPendingApply = (cwd: string): { ok: boolean; msg: string } => {
	const patchPath = join(zenseDir(cwd), PENDING_PATCH);
	if (!existsSync(patchPath))
		return { ok: false, msg: `${patchPath} not found — cannot undo automatically; revert manually: git restore --staged --worktree -- <paths>` };
	gitOk(["reset", "-q", "HEAD", "--", "."], cwd); 	if (readFileSync(patchPath, "utf8").trim()) {
		const rr = gitOk(["apply", "-R", "--whitespace=nowarn", patchPath], cwd);
		if (!rr.ok)
			return { ok: false, msg: `reverse-apply failed (were the applied files edited afterwards?): ${rr.err}\nNever delete human work silently — inspect yourself with git status / git diff` };
	}
	rmSync(patchPath, { force: true });
	rmSync(join(zenseDir(cwd), PENDING_MSG), { force: true });
	return { ok: true, msg: "discarded — main restored to its pre-apply state (reverse patch succeeded)" };
};

export interface AcceptResult {
	ok: boolean;
	msg: string;
	amendedFiles: string[];      	warnings: string[];          	committedOnBehalf: boolean;  }

export const acceptPendingApply = (
	cwd: string,
	opts: { evalTree?: string; preApplyHead?: string; commitIfStaged?: boolean } = {},
): AcceptResult => {
	const patchPath = join(zenseDir(cwd), PENDING_PATCH);
	if (!existsSync(patchPath))
		return { ok: false, msg: `no pending apply to accept (${PENDING_PATCH} not found — already accepted/committed, or never applied)`, amendedFiles: [], warnings: [], committedOnBehalf: false };
	const warnings: string[] = [];
	let committedOnBehalf = false;
	if (!gitOk(["diff", "--cached", "--quiet"], cwd).ok) {
				if (!opts.commitIfStaged)
			return {
				ok: false,
				msg: "staged changes are still pending (not yet committed) — either commit yourself with `git commit -F .zense/pending-apply.msg` then accept again, or ask the harness to commit for you (commitIfStaged=true / /zense accept commit)",
				amendedFiles: [],
				warnings,
				committedOnBehalf: false,
			};
		const cr = gitOk(["commit", "-F", join(zenseDir(cwd), PENDING_MSG)], cwd);
		if (!cr.ok)
			return { ok: false, msg: `commit on your behalf failed (hook rejected or missing config?): ${cr.err}\nCheck git status and commit manually`, amendedFiles: [], warnings, committedOnBehalf: false };
		committedOnBehalf = true;
	} else if (opts.preApplyHead && gitOk(["rev-parse", "HEAD"], cwd).out.trim() === opts.preApplyHead) {
		warnings.push(
			`index is empty but HEAD is still ${opts.preApplyHead.slice(0, 12)} (the pre-apply point) — the change likely vanished via out-of-band reset/stash rather than a commit; check git status / git log before trusting the work is in`,
		);
	}
	const amendedFiles: string[] = [];
	if (opts.evalTree) {
		const headTree = gitOk(["rev-parse", "HEAD^{tree}"], cwd);
		if (headTree.ok && headTree.out.trim() && headTree.out.trim() !== opts.evalTree) {
			const d = gitOk(["diff", "--name-only", opts.evalTree, "HEAD^{tree}", "--", ".", NOT_ZENSE], cwd);
			if (d.ok) amendedFiles.push(...d.out.split("\n").map((s) => s.trim()).filter(Boolean));
		}
	}
	rmSync(patchPath, { force: true });
	rmSync(join(zenseDir(cwd), PENDING_MSG), { force: true });
	return { ok: true, msg: "pending apply closed — the change is durable in main (further undo = plain git revert)", amendedFiles, warnings, committedOnBehalf };
};
