import { readModelLadder, swarmSlots } from "./swarm.ts";

export const LADDER_PROVIDER = "finisher";
export const LADDER_MODEL_ID = "auto";
export const LADDER_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

export type RouteReason = "user" | "continuation" | "retry" | "direct";

export interface LadderPick {
	pattern: string;
	rung: number;
}

export const splitPattern = (pattern: string): { provider: string; id: string; thinkingLevel?: string } | undefined => {
	const clean = pattern.trim();
	if (!clean) return undefined;
	const slash = clean.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = clean.slice(0, slash);
	const rest = clean.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	if (colon > 0) {
		const maybeLevel = rest.slice(colon + 1);
		if ((LADDER_THINKING_LEVELS as readonly string[]).includes(maybeLevel)) return { provider, id: rest.slice(0, colon), thinkingLevel: maybeLevel };
	}
	return { provider, id: rest };
};

export const ladderFromConfig = (cwd: string): string[] => readModelLadder(cwd);

export const pickLadderPattern = (ladder: string[], reason: RouteReason, messageCount: number): LadderPick | undefined => {
	if (!ladder.length) return undefined;
	const slots = swarmSlots(ladder);
	const idx = reason === "user" ? 0 : reason === "retry" ? Math.min(1, slots.length - 1) : reason === "direct" ? slots.length - 1 : Math.min(messageCount > 12 ? 1 : 0, slots.length - 1);
	const slot = slots[idx];
	return slot?.model ? { pattern: slot.model, rung: idx } : undefined;
};

export const buildVirtualModelDefinition = (opts: {
	provider: string;
	id: string;
	ladder: () => string[];
	findModel: (provider: string, id: string) => { provider: string; id: string } | undefined;
}): Record<string, unknown> => ({
	provider: opts.provider,
	id: opts.id,
	name: "Zense Ladder (auto)",
	thinkingLevels: LADDER_THINKING_LEVELS,
	route(request: { reason: RouteReason; previous?: { model?: { provider?: string; id?: string } }; messages: readonly unknown[] }) {
		const ladder = opts.ladder();
		if (request.reason !== "user" && request.previous?.model) {
			const prev = request.previous.model;
			const physical = opts.findModel(prev.provider ?? "", prev.id ?? "");
			if (physical) return { model: physical, thinkingLevel: "medium" };
		}
		const pick = pickLadderPattern(ladder, request.reason, request.messages.length);
		if (!pick) {
			const fallback = request.previous?.model;
			const physical = fallback ? opts.findModel(fallback.provider ?? "", fallback.id ?? "") : undefined;
			if (physical) return { model: physical, thinkingLevel: "medium" };
			throw new Error("finisher ladder: .finisher/models.json has no priority1..priority5 — set one pattern like \"provider/model\"");
		}
		const parts = splitPattern(pick.pattern);
		const physical = parts ? opts.findModel(parts.provider, parts.id) : undefined;
		if (!physical) throw new Error(`finisher ladder: "${pick.pattern}" does not resolve to a model with credentials`);
		return { model: physical, thinkingLevel: (parts?.thinkingLevel ?? "medium") as "off" | "low" | "medium" | "high" | "xhigh" | "max" };
	},
});

export interface RegisterLadderOpts {
	register: (model: {
		provider: string;
		id: string;
		name: string;
		thinkingLevels: readonly string[];
		route: (request: { reason: RouteReason; previous?: { model?: { provider?: string; id?: string } }; messages: readonly unknown[] }, ctx: { modelRegistry: { find: (provider: string, id: string) => unknown } }) => { model: unknown; thinkingLevel: string };
	}) => void;
	readLadder: () => string[];
}

export const registerLadderModel = (opts: RegisterLadderOpts): boolean => {
	opts.register({
		provider: LADDER_PROVIDER,
		id: LADDER_MODEL_ID,
		name: "Zense Ladder (auto)",
		thinkingLevels: LADDER_THINKING_LEVELS,
		route(request, extCtx) {
			const find = (provider: string, id: string) => extCtx.modelRegistry.find(provider, id);
			if (request.reason !== "user" && request.previous?.model) {
				const prev = request.previous.model;
				const physical = find(prev.provider ?? "", prev.id ?? "");
				if (physical) return { model: physical, thinkingLevel: "medium" };
			}
			const pick = pickLadderPattern(opts.readLadder(), request.reason, request.messages.length);
			const fallback = request.previous?.model ? find(request.previous.model.provider ?? "", request.previous.model.id ?? "") : undefined;
			if (!pick) {
				if (fallback) return { model: fallback, thinkingLevel: "medium" };
				throw new Error("finisher ladder: .finisher/models.json has no priority1..priority5 — set one pattern like \"provider/model\"");
			}
			const parts = splitPattern(pick.pattern);
			const physical = parts ? find(parts.provider, parts.id) : undefined;
			if (!physical) {
				if (fallback) return { model: fallback, thinkingLevel: "medium" };
				throw new Error(`finisher ladder: "${pick.pattern}" does not resolve to a model with credentials`);
			}
			return { model: physical, thinkingLevel: parts?.thinkingLevel ?? "medium" };
		},
	});
	return true;
};

export const ladderRoutable = (ladder: string[]): boolean => ladder.length > 0;

export const ladderLabel = (ladder: string[]): string => (ladder.length ? `${LADDER_PROVIDER}/${LADDER_MODEL_ID} → ${ladder.join(" > ")}` : `${LADDER_PROVIDER}/${LADDER_MODEL_ID} (not registered — no ladder configured)`);
