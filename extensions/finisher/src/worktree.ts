import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const GIT_TIMEOUT_MS = 120_000;

export const gitOk = (args: string[], cwd: string): { ok: boolean; out: string; err: string } => {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
		return { ok: true, out: out.toString(), err: "" };
	} catch (e: any) {
		const err = (e?.stderr?.toString?.() ?? e?.message ?? String(e)).split("\n")[0];
		return { ok: false, out: "", err };
	}
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

export const excludeInWorktree = (dir: string, pattern: string): boolean => {
	const rel = gitOk(["rev-parse", "--git-path", "info/exclude"], dir);
	if (!rel.ok) return false;
	const raw = rel.out.trim();
	const file = raw.startsWith("/") ? raw : join(dir, raw);
	try {
		const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (cur.split("\n").some((l) => l.trim() === pattern)) return true;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${pattern}\n`);
		return true;
	} catch {
		return false;
	}
};

export const linkDeps = (repo: string, dir: string): boolean => {
	const src = join(repo, "node_modules");
	const dst = join(dir, "node_modules");
	if (!existsSync(src) || existsSync(dst)) return false;
	try {
		symlinkSync(src, dst, "dir");
		excludeInWorktree(dir, "node_modules");
		return true;
	} catch {
		return false;
	}
};
