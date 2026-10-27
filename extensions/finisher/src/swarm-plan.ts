import { acceptanceBlock, contractBlock, isSafeSliceId, normalizeScope, scopesOverlap } from "./swarm-code.ts";

export interface PlanSlice {
	id: string;
	instruction: string;
	files: string[];
	acceptance: string[];
	dependsOn: string[];
}

export interface PlanInput {
	id?: unknown;
	instruction?: unknown;
	files?: unknown;
	scope?: unknown;
	acceptance?: unknown;
	depends_on?: unknown;
}

export const normalizeOwned = (raw: string): string => normalizeScope(raw.replace(/\/{2,}/g, "/"));

export const listOf = (raw: unknown): string[] =>
	Array.isArray(raw) ? raw.map((v) => (typeof v === "string" ? normalizeOwned(v) : "")).filter(Boolean) : [];

export const readPlanSlices = (raw: PlanInput[]): PlanSlice[] =>
	raw.map((s) => ({
		id: typeof s.id === "string" ? s.id.trim() : "",
		instruction: typeof s.instruction === "string" ? s.instruction.trim() : "",
		files: [...new Set([...listOf(s.files), ...listOf(s.scope)])],
		acceptance: listOf(s.acceptance).map((a) => a),
		dependsOn: [...new Set(listOf(s.depends_on))],
	}));

export interface Refusal {
	kind: "id" | "instruction" | "files" | "overlap" | "dep" | "cycle";
	slices: string[];
	detail: string;
}

export const declaredOverlaps = (slices: PlanSlice[]): { a: string; b: string; paths: string[] }[] => {
	const out: { a: string; b: string; paths: string[] }[] = [];
	for (let i = 0; i < slices.length; i++) {
		for (let j = i + 1; j < slices.length; j++) {
			const a = slices[i];
			const b = slices[j];
			const paths = a.files.flatMap((fa) => b.files.filter((fb) => scopesOverlap(fa, fb)).map((fb) => (fa.length <= fb.length ? fa : fb)));
			if (paths.length) out.push({ a: a.id, b: b.id, paths: [...new Set(paths)].sort((x, y) => x.localeCompare(y)) });
		}
	}
	return out.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
};

export const findCycles = (slices: PlanSlice[]): string[][] => {
	const byId = new Map(slices.map((s) => [s.id, s]));
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const visit = (id: string): void => {
		const mark = state.get(id) ?? 0;
		if (mark === 2) return;
		if (mark === 1) {
			const at = stack.indexOf(id);
			cycles.push([...stack.slice(at), id]);
			return;
		}
		state.set(id, 1);
		stack.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
		stack.pop();
		state.set(id, 2);
	};
	for (const s of [...slices].sort((a, b) => a.id.localeCompare(b.id))) visit(s.id);
	return cycles;
};

export const planRefusals = (slices: PlanSlice[]): Refusal[] => {
	const out: Refusal[] = [];
	const ids = new Set<string>();
	for (const s of slices) {
		if (!s.id || !isSafeSliceId(s.id)) out.push({ kind: "id", slices: [s.id || "(empty)"], detail: `slice id ${JSON.stringify(s.id)} is not usable — lowercase letters, digits, - or _ (max 32), no path separators` });
		else if (ids.has(s.id)) out.push({ kind: "id", slices: [s.id], detail: `slice id "${s.id}" appears twice — every worker needs its own slice` });
		ids.add(s.id);
		if (!s.instruction) out.push({ kind: "instruction", slices: [s.id || "(empty)"], detail: `slice ${s.id || "(empty)"} has no instruction — a coder with no job invents one` });
		if (!s.files.length) out.push({ kind: "files", slices: [s.id || "(empty)"], detail: `slice ${s.id || "(empty)"} declares no files — say which paths it owns, or two coders will edit the same file` });
	}
	for (const o of declaredOverlaps(slices))
		out.push({ kind: "overlap", slices: [o.a, o.b], detail: `${o.a} and ${o.b} both claim ${o.paths.join(", ")} — give each path to exactly one slice, or merge them into one` });
	for (const s of slices)
		for (const dep of s.dependsOn) {
			if (dep === s.id) out.push({ kind: "dep", slices: [s.id], detail: `slice ${s.id} depends on itself` });
			else if (!ids.has(dep)) out.push({ kind: "dep", slices: [s.id, dep], detail: `slice ${s.id} depends on "${dep}", which is not a slice in this call` });
		}
	for (const cycle of findCycles(slices)) out.push({ kind: "cycle", slices: cycle, detail: `${cycle.join(" → ")} — a dependency cycle can never start` });
	return out;
};

export const CODER_FLOOR = 2;

export const coderFloor = (slices: number): { spawn: boolean; coders: number } => {
	const n = Number.isFinite(slices) ? Math.max(0, Math.floor(slices)) : 0;
	return { spawn: n >= CODER_FLOOR, coders: n };
};

export const MAIN_ALONGSIDE_LINE =
	"A fan-out only happens while the main agent codes its own slice in the same turn — main works alongside the coders and never sits idle waiting for them.";

export const coderFloorNote = (slices: number): string =>
	[
		`code refused: ${slices} slice(s) is a lone CODER, and a lone CODER is never spawned — one CODER is slower than doing it yourself.`,
		`A fan-out only pays off when at least ${CODER_FLOOR} coders run side by side while the main agent codes its own slice in the same turn.`,
		"Do this slice yourself in the main agent instead. If the work really splits into independent slices, call code again with every slice as a separate item in ONE call — never several one-slice calls.",
	].join("\n");

export const planRefusalText = (refusals: Refusal[], spawned: string): string =>
	[
		`code refused the plan before spawning anything (${spawned}):`,
		...refusals.map((r) => `  ✗ ${r.detail}`),
		"Fix the plan and call it again: every slice needs its own files and its dependencies named. Nothing was started.",
	].join("\n");

export const planOrder = (slices: PlanSlice[]): { order: string[]; depth: Record<string, number> } => {
	const byId = new Map(slices.map((s) => [s.id, s]));
	const depth: Record<string, number> = {};
	const seen = new Set<string>();
	const walk = (id: string, from: string[]): number => {
		if (depth[id] !== undefined) return depth[id];
		if (from.includes(id)) return 0;
		const s = byId.get(id);
		const d = s ? Math.max(0, ...s.dependsOn.filter((x) => byId.has(x)).map((x) => walk(x, [...from, id]) + 1)) : 0;
		depth[id] = d;
		return d;
	};
	for (const s of slices) walk(s.id, []);
	const order = slices
		.map((s) => s.id)
		.filter((id) => !seen.has(id) && (seen.add(id), true))
		.sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0) || a.localeCompare(b));
	return { order, depth };
};

export const blockedBy = (slices: PlanSlice[], failed: string[]): Record<string, string[]> => {
	const out: Record<string, string[]> = {};
	const dead = new Set(failed);
	for (const s of slices) {
		const hits = s.dependsOn.filter((d) => dead.has(d));
		if (hits.length) out[s.id] = hits;
	}
	return out;
};

export const contractLines = (_slices: PlanSlice[], sharedContract?: string): string[] => contractBlock(sharedContract);

export const acceptanceLines = (slice: PlanSlice): string[] => acceptanceBlock(slice.acceptance);
