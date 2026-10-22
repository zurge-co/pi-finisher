
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Spec, type Tracker, type Worktree, type PendingApply } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { PENDING_PATCH, NOT_ZENSE } from "./pending-apply.ts";

export const loadSpecFromDisk = (cwd: string): Spec | null => {
	try {
		const p = join(zenseDir(cwd), "spec.json");
		if (!existsSync(p)) return null;
		const s = JSON.parse(readFileSync(p, "utf8")) as Partial<Spec>;
		if (!s || typeof s.version !== "number" || typeof s.title !== "string") return null;
		if (!Array.isArray(s.scope) || !Array.isArray(s.criteria)) return null;
		return {
			version: s.version,
			title: s.title,
			intent: typeof s.intent === "string" ? s.intent : "",
			...(Array.isArray(s.approach) ? { approach: s.approach } : {}),
			scope: s.scope,
			constraints: Array.isArray(s.constraints) ? s.constraints : [],
			criteria: s.criteria,
			specDebt: Array.isArray(s.specDebt) ? s.specDebt : [],
			approved: s.approved === true,
			...(typeof s.approvedAt === "number" ? { approvedAt: s.approvedAt } : {}),
			...(Array.isArray(s.changesFrom) ? { changesFrom: s.changesFrom } : {}),
		};
	} catch {
		return null;
	}
};

export const findSpecArchivePaths = (cwd: string, version: number): { json?: string; md?: string } => {
	try {
		const dir = join(zenseDir(cwd), "specs");
		if (!existsSync(dir)) return {};
		const files = readdirSync(dir)
			.filter((f) => f.includes(`-v${version}-`))
			.sort();
		const jsons = files.filter((f) => f.endsWith(".json"));
		const mds = files.filter((f) => f.endsWith(".md"));
		return {
			...(jsons.length ? { json: join(dir, jsons[jsons.length - 1]) } : {}),
			...(mds.length ? { md: join(dir, mds[mds.length - 1]) } : {}),
		};
	} catch {
		return {};
	}
};

export const findSessionWorktree = (cwd: string, specVersion: number): { wt: Worktree; exactVersion: boolean } | null => {
	try {
		const parent = join(zenseDir(cwd), "worktree");
		if (!existsSync(parent)) return null;
		const candidates: { wt: Worktree; exactVersion: boolean }[] = [];
		for (const entry of readdirSync(parent)) {
			const dir = join(parent, entry);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			if (!gitOk(["rev-parse", "--is-inside-work-tree"], dir).ok) continue; 			const br = gitOk(["rev-parse", "--abbrev-ref", "HEAD"], dir);
			if (!br.ok || !br.out.trim().startsWith("zense/impl/")) continue;
			const branch = br.out.trim();
			candidates.push({ wt: { root: dir, branch, dir }, exactVersion: branch.startsWith(`zense/impl/v${specVersion}-`) });
		}
		const exact = candidates.find((c) => c.exactVersion);
		if (exact) return exact;
		return candidates.length === 1 ? candidates[0] : null; 	} catch {
		return null;
	}
};

export const restorePendingApply = (cwd: string, specVersion: number): PendingApply | null => {
	try {
		const patchPath = join(zenseDir(cwd), PENDING_PATCH);
		if (!existsSync(patchPath)) return null;
		if (gitOk(["diff", "--cached", "--quiet"], cwd).ok) return null; 		const names = gitOk(["diff", "--cached", "--name-only", "--", ".", NOT_ZENSE], cwd);
		return {
			specVersion,
			branch: "(resumed)",
			paths: names.ok ? names.out.trim().split("\n").filter(Boolean) : [],
			appliedAt: statSync(patchPath).mtimeMs,
		};
	} catch {
		return null;
	}
};

export interface ResumeDiscovery {
	spec: Spec;
	specJsonPath?: string;
	specMdPath?: string;
	worktree?: Worktree;
	worktreeExactVersion?: boolean; 	pendingApply?: PendingApply;
}

export const discoverLongrunTrackers = (cwd: string): Tracker[] => {
	try {
		const root = join(zenseDir(cwd), "long-running");
		if (!existsSync(root)) return [];
		const out: Tracker[] = [];
		for (const entry of readdirSync(root)) {
			try {
				const p = join(root, entry, "tracker.json");
				if (!statSync(p).isFile()) continue;
				const t = JSON.parse(readFileSync(p, "utf8")) as Tracker;
				if (t && typeof t.slug === "string" && Array.isArray(t.phases)) out.push(t);
			} catch {
			}
		}
		return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	} catch {
		return [];
	}
};

export const discoverResumeState = (cwd: string): ResumeDiscovery | null => {
	const spec = loadSpecFromDisk(cwd);
	if (!spec) return null;
	const arch = findSpecArchivePaths(cwd, spec.version);
	const out: ResumeDiscovery = {
		spec,
		...(arch.json ? { specJsonPath: arch.json } : {}),
		...(arch.md ? { specMdPath: arch.md } : {}),
	};
	const found = findSessionWorktree(cwd, spec.version);
	if (found) {
		out.worktree = found.wt;
		out.worktreeExactVersion = found.exactVersion;
	}
	if (spec.approved) {
		const pa = restorePendingApply(cwd, spec.version);
		if (pa) out.pendingApply = pa;
	}
	return out;
};
