export const SWARM_TOOL = "code";

export interface BudgetInput {
	toolCapMs: number;
	subagentMs: number;
	attempts: number;
	waves: number;
}

export const wavesFor = (tasks: number, concurrency: number): number => {
	if (tasks < 1 || concurrency < 1) return 0;
	return Math.ceil(tasks / concurrency);
};

export const swarmWallMs = (input: Omit<BudgetInput, "toolCapMs">): number => Math.max(0, input.attempts) * Math.max(0, input.subagentMs) * Math.max(1, input.waves);

export const BUDGET_SLACK = 1.25;

export const budgetFits = (input: BudgetInput): boolean => swarmWallMs(input) <= input.toolCapMs;

export const capNeededFor = (input: Omit<BudgetInput, "toolCapMs">): number => Math.round(swarmWallMs(input) * BUDGET_SLACK);

export const budgetNote = (input: BudgetInput): string | undefined => {
	if (budgetFits(input)) return undefined;
	const need = Math.round(swarmWallMs(input) / 1000);
	const have = Math.round(input.toolCapMs / 1000);
	return `⚠ budget: this fan-out can take up to ${need}s (${input.attempts} attempt(s) × ${Math.round(input.subagentMs / 1000)}s × ${input.waves} wave(s)) but the tool cap is ${have}s — lower maxAttempts, raise toolTimeoutMs in .finisher/config.json, or widen swarmConcurrency`;
};

export const MAX_EFFORT = 5;
export const MAX_ATTEMPTS_CEILING = MAX_EFFORT;

export const effortFor = (requested?: number): number => {
	const n = Math.floor(Number(requested ?? 2));
	return Number.isFinite(n) ? Math.max(1, Math.min(n, MAX_EFFORT)) : 2;
};
