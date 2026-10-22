export interface CodeSlice {
	id: string;
	instruction: string;
	scope?: string[];
}

export interface SlicePlan {
	id: string;
	worktreeDir: string;
	branch: string;
	scopes: string[];
}

export interface SliceOutcome {
	id: string;
	ok: boolean;
	paths: string[];
	diff?: string;
	output?: string;
}

export interface OverlapPair {
	a: string;
	b: string;
	paths: string[];
}

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const isSafeSliceId = (id: string): boolean => SAFE_ID.test(id) && !id.includes("..");

export const normalizeScope = (raw: string): string => raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

export const scopesOverlap = (a: string, b: string): boolean => {
	const x = normalizeScope(a);
	const y = normalizeScope(b);
	if (!x || !y) return true;
	if (x === y) return true;
	return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

export const planSlice = (slice: CodeSlice, runRoot: string, runId: string, branches: string[] = []): SlicePlan => {
	if (!isSafeSliceId(slice.id)) throw new Error(`unsafe slice id "${slice.id}" — use lowercase letters, digits, - or _ (max 32 chars, no path separators)`);
	const branchBase = `zense/swarm/${runId}/${slice.id}`;
	let branch = branchBase;
	for (let n = 2; branches.includes(branch); n++) branch = `${branchBase}-${n}`;
	const worktreeDir = `${runRoot.replace(/\/+$/, "")}/${slice.id}`;
	if (!worktreeDir.startsWith(runRoot.replace(/\/+$/, ""))) throw new Error(`slice ${slice.id} would escape its run root`);
	return { id: slice.id, worktreeDir, branch, scopes: (slice.scope ?? []).map(normalizeScope).filter(Boolean) };
};

export const planSlices = (slices: CodeSlice[], runRoot: string, runId: string): SlicePlan[] => {
	const seen = new Set<string>();
	const branches: string[] = [];
	const out: SlicePlan[] = [];
	for (const s of slices) {
		if (seen.has(s.id)) throw new Error(`duplicate slice id "${s.id}" — every worker needs its own worktree`);
		seen.add(s.id);
		const plan = planSlice(s, runRoot, runId, branches);
		branches.push(plan.branch);
		out.push(plan);
	}
	return out;
};

export const touchedPaths = (outcomes: SliceOutcome[]): Map<string, string[]> => {
	const byPath = new Map<string, string[]>();
	for (const o of [...outcomes].sort((a, b) => a.id.localeCompare(b.id))) {
		for (const p of new Set(o.paths.map(normalizeScope))) {
			const owners = byPath.get(p) ?? [];
			owners.push(o.id);
			byPath.set(p, owners);
		}
	}
	return byPath;
};

export const findOverlaps = (outcomes: SliceOutcome[]): OverlapPair[] => {
	const pairs = new Map<string, OverlapPair>();
	for (const [path, owners] of touchedPaths(outcomes)) {
		const uniq = [...new Set(owners)].sort((a, b) => a.localeCompare(b));
		for (let i = 0; i < uniq.length; i++)
			for (let j = i + 1; j < uniq.length; j++) {
				const key = `${uniq[i]}\u0000${uniq[j]}`;
				const found = pairs.get(key) ?? { a: uniq[i], b: uniq[j], paths: [] };
				found.paths.push(path);
				pairs.set(key, found);
			}
	}
	return [...pairs.values()].map((p) => ({ ...p, paths: [...p.paths].sort((a, b) => a.localeCompare(b)) })).sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
};

export const mergeOrder = (outcomes: SliceOutcome[]): SliceOutcome[] =>
	[...outcomes].filter((o) => o.ok).sort((a, b) => a.id.localeCompare(b.id));

export interface MergeStep {
	id: string;
	apply: boolean;
	reason?: string;
}

export interface MergePlan {
	order: string[];
	steps: MergeStep[];
	overlaps: OverlapPair[];
	blocked: string[];
}

export const planMerge = (outcomes: SliceOutcome[], opts: { allowOverlap?: boolean } = {}): MergePlan => {
	const overlaps = findOverlaps(outcomes);
	const contested = new Set<string>();
	for (const o of overlaps) {
		contested.add(o.a);
		contested.add(o.b);
	}
	const ordered = mergeOrder(outcomes);
	const steps: MergeStep[] = ordered.map((o) => {
		if (contested.has(o.id) && !opts.allowOverlap)
			return { id: o.id, apply: false, reason: `path overlap with ${overlaps.filter((p) => p.a === o.id || p.b === o.id).map((p) => (p.a === o.id ? p.b : p.a)).join(", ")} — resolve by hand, never merge silently` };
		return { id: o.id, apply: true };
	});
	return { order: ordered.map((o) => o.id), steps, overlaps, blocked: steps.filter((s) => !s.apply).map((s) => s.id) };
};

export const mergeSignature = (plan: MergePlan): string => plan.steps.map((s) => `${s.id}:${s.apply ? "apply" : "block"}`).join("|");

export const buildCodeWorkerPrompt = (slice: CodeSlice, opts: { goal?: string; worktreeDir: string; scopes: string[] }): string =>
	[
		`You are swarm coder ${slice.id}. GOAL: ${opts.goal ?? "(goal supplied by the main agent)"}`,
		`You work ALONE in your own checkout: ${opts.worktreeDir}. Other coders are editing other checkouts of the same repo at the same time.`,
		opts.scopes.length ? `Stay inside your slice's paths: ${opts.scopes.join(", ")}. Touching a file outside them is a conflict with another coder.` : "No explicit paths were given: keep the change as narrow as the instruction.",
		"Write the code for YOUR slice only, then stop. Do not try to merge, commit, rebase or touch another slice's files.",
		"Code rules: no comments in code (line or block). Names and structure carry the intent. A file you create must stay at or under 500 lines.",
		"End with exactly one line: FILES: <comma-separated repo-relative paths you changed>",
		"",
		`Your slice (${slice.id}): ${slice.instruction}`,
	].join("\n");

const isRepoRelative = (path: string): boolean => !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split("/").includes("..");

export const parseWorkerFiles = (output: string): string[] => {
	const line = output
		.split("\n")
		.map((l) => l.trim())
		.reverse()
		.find((l) => /^FILES:/i.test(l));
	if (!line) return [];
	return line
		.replace(/^FILES:/i, "")
		.split(/[,\s]+/)
		.map(normalizeScope)
		.filter((p) => p && isRepoRelative(p));
};

export const mergeReport = (plan: MergePlan, outcomes: SliceOutcome[]): string => {
	const lines = [`merge plan (deterministic by slice id): ${plan.order.join(" → ") || "(nothing to merge)"}`];
	for (const step of plan.steps) {
		const o = outcomes.find((x) => x.id === step.id);
		lines.push(`  ${step.apply ? "✓ apply" : "⛔ block"} ${step.id}${o && o.paths.length ? ` — ${o.paths.length} file(s)` : ""}${step.reason ? ` (${step.reason})` : ""}`);
	}
	if (plan.overlaps.length) {
		lines.push("overlaps (never merged silently):");
		for (const o of plan.overlaps) lines.push(`  ${o.a} ↔ ${o.b}: ${o.paths.join(", ")}`);
	}
	return lines.join("\n");
};
