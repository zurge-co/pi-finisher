
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Spec, type Worktree, type PendingApply } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { NOT_ZENSE } from "./pending-apply.ts";

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

export interface ResumeDiscovery {
	spec: Spec;
	specJsonPath?: string;
	specMdPath?: string;
}

export const discoverResumeState = (cwd: string): ResumeDiscovery | null => {
	const spec = loadSpecFromDisk(cwd);
	if (!spec) return null;
	const arch = findSpecArchivePaths(cwd, spec.version);
	const out: ResumeDiscovery = {
		spec,
		...(arch.json ? { specJsonPath: arch.json } : {}),
		...(arch.md ? { specMdPath: arch.md } : {}),
	};
	return out;
};
