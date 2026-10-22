
import { extractJsonObject, parseSpecDraft, type SpecDraft } from "./spec-draft.ts";

export interface PlannerSubtask { id: string; title: string; intent: string; scope?: string }

export const DECOMPOSE_MAX_WORDS = 100;
export const DECOMPOSE_MAX_CHARS = 800;
export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
export const needsDecompose = (intent: string): boolean =>
	wordCount(intent) > DECOMPOSE_MAX_WORDS || intent.trim().length > DECOMPOSE_MAX_CHARS;

export const buildPlannerPrompt = (intent: string, timeoutMs = 300_000): string =>
	`You are the PLANNER sub-agent for a spec-gated SDLC harness. The task below is too large to hand to a single requirements agent (it would exceed its time budget), so your ONLY job is to decompose it into subtasks. You do NOT draft the spec yourself — a separate requirements agent will handle each subtask, seeing ONLY that subtask's "intent" text (never this message, never the other subtasks).

` +
	`Output exactly ONE JSON object — no markdown fences, no commentary:
{"subtasks": [{"id": "t1", "title": "short title", "intent": "self-contained description — repeat any shared context the requirements agent will need", "scope": "optional path prefix this subtask may touch"}]}
` +
	`Rules:
- 2 to 8 subtasks. If the task does not split naturally, split by layer instead (core logic vs wiring vs tests/docs).
- Execution is SEQUENTIAL in your array order — earlier subtasks must never depend on later ones.
- Each "intent" must stand alone; never write "same as above" or reference other subtasks by name.
- ids must be unique, short, stable (t1, t2, …).
- You run under a HARD wall-clock limit of about ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes and you are READ-ONLY — you may skim README/package layout briefly to ground the split, but do not run test suites and do not modify anything.

Task: ${intent}`;

export const parsePlannerSubtasks = (text: string): PlannerSubtask[] => {
	const raw = extractJsonObject(text);
	if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("planner output is not a JSON object (no parseable JSON found — the prompt instructs output ONLY JSON)");
	const o = (raw as Record<string, unknown>).subtasks;
	if (!Array.isArray(o) || o.length < 2 || o.length > 8)
		throw new Error(`planner output: subtasks must be an array of 2–8 items (got ${Array.isArray(o) ? o.length : "non-array"})`);
	const seen = new Set<string>();
	const out: PlannerSubtask[] = [];
	for (let i = 0; i < o.length; i++) {
		const s = o[i] as Record<string, unknown> | null;
		if (!s || typeof s !== "object") throw new Error(`planner output: subtasks[${i}] is not an object`);
		const id = typeof s.id === "string" ? s.id.trim() : "";
		const title = typeof s.title === "string" ? s.title.trim() : "";
		const intent = typeof s.intent === "string" ? s.intent.trim() : "";
		if (!id) throw new Error(`planner output: subtasks[${i}].id is empty or not a string`);
		if (seen.has(id)) throw new Error(`planner output: subtask id "${id}" is duplicated`);
		if (!title) throw new Error(`planner output: subtasks[${i}].title is empty`);
		if (!intent) throw new Error(`planner output: subtasks[${i}].intent is empty — the requirements agent sees only this field, it must not be empty`);
		seen.add(id);
		const scope = typeof s.scope === "string" && s.scope.trim() ? s.scope.trim() : undefined;
		out.push({ id, title, intent, ...(scope ? { scope } : {}) });
	}
	return out;
};

export const mergeSubtaskDrafts = (title: string, intent: string, drafts: { subtask: string; draft: SpecDraft }[]): SpecDraft => ({
	title,
	intent,
			crossCheck: [...new Set(drafts.flatMap((d) => d.draft.crossCheck ?? []))],
		outcomes: [...new Set(drafts.map((d) => d.draft.outcomes).filter(Boolean))].join("\n\n") || undefined,
	approach: drafts.flatMap((d) => d.draft.approach.map((a) => `[${d.subtask}] ${a}`)),
	scope: [...new Set(drafts.flatMap((d) => d.draft.scope))],
	constraints: [...new Set(drafts.flatMap((d) => d.draft.constraints))],
	criteria: drafts.flatMap((d) => d.draft.criteria).map((c, i) => ({ ...c, id: `c${i + 1}` })),
	specDebt: [...new Set(drafts.flatMap((d) => d.draft.specDebt))],
});

export const compileDecomposed = async (
	intent: string,
	runTask: (role: "planner" | "requirements", task: string) => Promise<{ ok: boolean; output: string }>,
	mkRequirementsPrompt: (subtask: PlannerSubtask) => string,
	plannerTimeoutMs = 300_000,
): Promise<{ subtasks: PlannerSubtask[]; drafts: { subtask: string; draft: SpecDraft }[] }> => {
	const plan = await runTask("planner", buildPlannerPrompt(intent, plannerTimeoutMs));
	if (!plan.ok) throw new Error(`planner sub-agent failed: ${plan.output.split("\n")[0].slice(0, 200)}`);
	const subtasks = parsePlannerSubtasks(plan.output);
	const drafts: { subtask: string; draft: SpecDraft }[] = [];
	for (const st of subtasks) {
		const r = await runTask("requirements", mkRequirementsPrompt(st));
		if (!r.ok) throw new Error(`requirements sub-agent failed on subtask ${st.id} ("${st.title}"): ${r.output.split("\n")[0].slice(0, 200)}`);
		const parsed = parseSpecDraft(r.output);
		if (parsed.kind === "clarify")
			throw new Error(`subtask ${st.id}: requirements asked to clarify (${parsed.questions.length} question(s)) — decompose has no per-subtask clarify; caller falls back to a single compile`);
		if (parsed.kind === "error")
			throw new Error(`subtask ${st.id}: draft invalid — ${parsed.error}`);
		drafts.push({ subtask: st.id, draft: parsed.draft });
	}
	return { subtasks, drafts };
};
