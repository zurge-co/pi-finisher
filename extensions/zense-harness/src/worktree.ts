
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { zenseDir, type Spec, type Worktree } from "./types.ts";

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const rewritePathForWorktree = (cwd: string, wtRoot: string, path: string): string => {
	if (!path) return path;
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs).split(sep).join("/");
	if (!rel || rel.startsWith("..")) return path;           	if (rel === ".zense" || rel.startsWith(".zense/")) return path; 	return join(wtRoot, rel);
};

export const buildWorktreeCommand = (cmd: string, wtRoot: string): string =>
	`cd ${shellQuote(wtRoot)} && ${cmd}`;

export const gitOk = (args: string[], cwd: string): { ok: boolean; out: string; err: string } => {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: out.toString(), err: "" };
	} catch (e: any) {
		const err = (e?.stderr?.toString?.() ?? e?.message ?? String(e)).split("\n")[0];
		return { ok: false, out: "", err };
	}
};

export const canReuseWorktree = (wt: Worktree | null | undefined): boolean => !!wt && existsSync(wt.root);

export const createWorktree = (cwd: string, spec: Spec): Worktree | null => {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const branch = `zense/impl/v${spec.version}-${stamp}`;
	const wtParent = join(zenseDir(cwd), "worktree");
	const wtRoot = join(wtParent, `${basename(cwd)}-wt-${stamp}`);
	mkdirSync(wtParent, { recursive: true });
	const head = gitOk(["rev-parse", "HEAD"], cwd); 	if (gitOk(["worktree", "add", wtRoot, "-b", branch], cwd).ok !== true) return null;
	excludeFromGitStatus(cwd, wtParent);
				const wtZense = join(wtRoot, ".zense");
	mkdirSync(wtZense, { recursive: true });
	for (const f of ["spec.json", "spec.md", "memory.jsonl"]) {
		const src = join(zenseDir(cwd), f);
		if (existsSync(src)) copyFileSync(src, join(wtZense, f));
	}
	const adrSrc = join(zenseDir(cwd), "adr");
	if (existsSync(adrSrc)) cpSync(adrSrc, join(wtZense, "adr"), { recursive: true });
	return { root: wtRoot, branch, dir: wtRoot, ...(head.ok ? { baseline: head.out.trim() } : {}) };
};

export const excludeFromGitStatus = (cwd: string, absPath: string): void => {
	try {
		const top = gitOk(["rev-parse", "--show-toplevel"], cwd);
		if (!top.ok) return;
		const repoRoot = realpathSync(top.out.trim());
		const rel = relative(repoRoot, realpathSync(absPath)).split(sep).join("/");
		if (!rel || rel.startsWith("..")) return;
		const gitCommon = gitOk(["rev-parse", "--git-common-dir"], cwd);
		if (!gitCommon.ok) return;
		const excludeFile = join(resolve(cwd, gitCommon.out.trim()), "info", "exclude");
		const line = `/${rel}/`;
		const cur = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
		if (cur.split("\n").some((l) => l.trim() === line)) return;
		appendFileSync(excludeFile, `${cur && !cur.endsWith("\n") ? "\n" : ""}${line}\n`);
	} catch {
	}
};
