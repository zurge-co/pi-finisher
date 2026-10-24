import { type VerifyReport } from "./verify-loop.ts";

export interface GoalPhase {
	id: string;
	text: string;
	round: number;
	addedAt: number;
	lapMs?: number;
}

export interface PhasePlan {
	phases: GoalPhase[];
	lap: number;
	lapAt: number;
	lapMs: number[];
}

export const FIX_PHASES_MAX = 6;
export const PHASE_TEXT_MAX = 200;

export const emptyPlan = (): PhasePlan => ({ phases: [], lap: 0, lapAt: 0, lapMs: [] });

export const planOf = (goal: { phases?: GoalPhase[]; lap?: number; lapAt?: number; lapMs?: number[] } | undefined): PhasePlan =>
	goal?.phases?.length
		? { phases: goal.phases, lap: Math.max(0, goal.lap ?? 0), lapAt: Math.max(0, goal.lapAt ?? 0), lapMs: goal.lapMs ?? [] }
		: emptyPlan();

export const withPlan = (goal: object, plan: PhasePlan): { phases: GoalPhase[]; lap: number; lapAt: number; lapMs: number[] } => ({
	...goal,
	phases: plan.phases,
	lap: plan.lap,
	lapAt: plan.lapAt,
	lapMs: plan.lapMs,
});

const shortId = (text: string): string => {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 12);
	return `p-${slug || "step"}`;
};

const uniqueId = (taken: GoalPhase[], base: string): string => {
	if (!taken.some((p) => p.id === base)) return base;
	let n = 2;
	while (taken.some((p) => p.id === `${base}-${n}`)) n += 1;
	return `${base}-${n}`;
};

export const makePhases = (texts: string[], round: number, at: number, taken: GoalPhase[] = []): GoalPhase[] => {
	const out: GoalPhase[] = [];
	for (const raw of texts) {
		const text = raw.trim().slice(0, PHASE_TEXT_MAX);
		if (!text) continue;
		const id = uniqueId([...taken, ...out], shortId(text));
		out.push({ id, text, round, addedAt: at });
	}
	return out;
};

export const declarePlan = (texts: string[], at = Date.now()): PhasePlan => {
	const phases = makePhases(texts, 0, at);
	return phases.length ? { phases, lap: 1, lapAt: at, lapMs: [] } : emptyPlan();
};

export const appendPhases = (plan: PhasePlan, texts: string[], round: number, at = Date.now()): PhasePlan => {
	const added = makePhases(texts, round, at, plan.phases);
	if (!added.length) return plan;
	if (!totalPhases(plan)) return { phases: added, lap: 1, lapAt: at, lapMs: [] };
	return { phases: [...plan.phases, ...added], lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs };
};

export const totalPhases = (plan: PhasePlan): number => plan.phases.length;

export const allLapsDone = (plan: PhasePlan): boolean => totalPhases(plan) > 0 && plan.lap > totalPhases(plan);

export const lapIndex = (plan: PhasePlan): number => Math.min(Math.max(1, plan.lap), Math.max(1, totalPhases(plan)));

export const currentLap = (plan: PhasePlan): GoalPhase | undefined =>
	totalPhases(plan) ? plan.phases[lapIndex(plan) - 1] : undefined;

export const lapLabel = (plan: PhasePlan): string => {
	const total = totalPhases(plan);
	if (!total) return "PLAN";
	return `LAP ${lapIndex(plan)}/${total}`;
};

export const doneCount = (plan: PhasePlan): number => Math.max(0, Math.min(totalPhases(plan), plan.lap - 1));

export const completeLap = (plan: PhasePlan, ref?: string | number, at = Date.now()): PhasePlan => {
	const total = totalPhases(plan);
	if (!total || allLapsDone(plan)) return plan;
	const current = lapIndex(plan);
	const index = ref === undefined ? current - 1 : typeof ref === "number" ? ref - 1 : plan.phases.findIndex((p) => p.id === ref);
	if (!Number.isInteger(index) || index < 0 || index >= total) return plan;
	if (index + 1 !== current) return plan;
	const spent = plan.lapAt > 0 ? Math.max(0, at - plan.lapAt) : Math.max(0, at - plan.phases[index].addedAt);
	const lapMs = [...plan.lapMs];
	lapMs[index] = spent;
	return { phases: plan.phases, lap: index + 2, lapAt: at, lapMs };
};

const reasonOf = (caseId: string, verdict: string, reason?: string): string => `${caseId} ${verdict}${reason ? ` — ${reason}` : ""}`;

export const fixPhases = (report: VerifyReport): string[] => {
	const out: string[] = [];
	const byId = new Map(report.cases.map((c) => [c.caseId, c]));
	const reason = (caseId: string): string => {
		const c = byId.get(caseId);
		return c ? reasonOf(c.caseId, c.verdict, c.reason) : caseId;
	};
	for (const caseId of report.failed) out.push(`fix ${reason(caseId)}`);
	for (const caseId of report.unverified) out.push(`make ${reason(caseId)} provable by a command that exits 0`);
	for (const caseId of report.blocked ?? []) out.push(`make ${reason(caseId)} runnable — a case that never produced output proves nothing`);
	return out.slice(0, FIX_PHASES_MAX);
};

export const planGrewBy = (before: PhasePlan, after: PhasePlan): number => Math.max(0, totalPhases(after) - totalPhases(before));

export const phaseListLines = (plan: PhasePlan, cap = 15): string[] =>
	plan.phases.slice(0, cap).map((p, i) => {
		const mark = i + 1 < plan.lap ? "✓" : i + 1 === plan.lap ? "▶" : "·";
		return `  ${mark} ${i + 1}. ${p.text}`;
	});

export interface PhaseGate {
	allowed: boolean;
	note: string;
}

export const verifyGate = (plan: PhasePlan): PhaseGate => {
	if (!totalPhases(plan) || allLapsDone(plan)) return { allowed: true, note: "" };
	const next = currentLap(plan);
	return {
		allowed: false,
		note: [
			`verify is gated: ${lapLabel(plan)} is still open${next ? ` — ${next.text}` : ""}.`,
			"finish every lap with finisher_phase done=<id> (or bare `done` for the current lap), then call finisher_verify exactly once — you are the verifier, no sub-agent judges your work.",
			"verification is one shot at the end of the plan, never per lap.",
		].join("\n"),
	};
};
