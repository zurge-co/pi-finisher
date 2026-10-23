import { classifyKeep, distillPrompt, handoffQuestion, handoffKeepProbability, isWorthKeeping, type HandoffAnswerLike, type HandoffItem } from "./handoff-stack.ts";

export const CLASSIFIER_PREFERENCE = ["typesafe/jev-latest", "cloudflare-workers-ai/@cf/cloudflare/clef-flash", "cloudflare-workers-ai/@cf/cloudflare/clef", "openai/gpt-6-luna"] as const;

export interface ClassifierRef {
	provider: string;
	id: string;
}

export interface ClassifierGateway {
	available: (preference: readonly string[]) => Promise<ClassifierRef | undefined>;
	classify: (model: ClassifierRef, state: Record<string, unknown>, question: Record<string, unknown>) => Promise<{ answers?: Record<string, HandoffAnswerLike>; stopReason?: string } | undefined>;
}

export interface KeepDecision {
	keep: boolean;
	why: "classifier" | "heuristic" | "no-classifier" | "classifier-error" | "too-thin";
	probability?: number;
}

export const parsePreference = (pattern: string): ClassifierRef | undefined => {
	const slash = pattern.indexOf("/");
	return slash > 0 ? { provider: pattern.slice(0, slash), id: pattern.slice(slash + 1) } : undefined;
};

export const preferenceRefs = (preference: readonly string[] = CLASSIFIER_PREFERENCE): ClassifierRef[] => preference.map(parsePreference).filter((r): r is ClassifierRef => !!r);

export const decideKeep = async (gateway: ClassifierGateway | undefined, opts: { from: string; text: string; preference?: readonly string[]; threshold?: number }): Promise<KeepDecision> => {
	if (!isWorthKeeping(opts.text)) return { keep: false, why: "too-thin" };
	if (!gateway) return { keep: false, why: "no-classifier" };
	const model = await gateway.available(opts.preference ?? CLASSIFIER_PREFERENCE);
	if (!model) return { keep: false, why: "no-classifier" };
	let out: Awaited<ReturnType<ClassifierGateway["classify"]>>;
	try {
		out = await gateway.classify(model, { from: opts.from, text: opts.text.slice(0, 4_000) }, { keep: handoffQuestion().keep as Record<string, unknown> });
	} catch {
		return { keep: false, why: "classifier-error" };
	}
	if (!out || out.stopReason === "error" || out.stopReason === "aborted") return { keep: false, why: "classifier-error" };
	const answer = out.answers?.keep;
	const probability = handoffKeepProbability(answer);
	return { keep: classifyKeep(answer, opts.threshold), why: "classifier", probability };
};

export const needsClassifierSetup = (d: KeepDecision): boolean => d.why === "no-classifier" || d.why === "classifier-error";

export const describeDecision = (d: KeepDecision, from: string): string => {
	if (d.why === "too-thin") return `handoff: dropped a ${from} note (too thin to carry)`;
	if (d.why === "no-classifier") return `handoff: dropped a ${from} note (no classifier with credentials — nothing is kept without a verdict)`;
	if (d.why === "classifier-error") return `handoff: dropped a ${from} note (the classifier failed, so the note stays unvetted)`;
	const verdict = d.keep ? "kept" : "dropped";
	return `handoff: ${verdict} a ${from} note (classifier p=${d.probability?.toFixed(2) ?? "?"})`;
};

export const classifierGuidance = (): string =>
	[
		"nothing is carried across tasks because no handoff classifier has credentials.",
		"log in one of: typesafe (TYPESAFE_API_KEY), cloudflare-workers-ai (CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID), or openai (OPENAI_API_KEY for gpt-6-luna).",
	].join(" ");

export interface ClassifierRegistryLike {
	getAvailableOfType: (...args: never[]) => Promise<readonly unknown[]>;
	getModelOfType: (...args: never[]) => unknown;
	classify: (...args: never[]) => Promise<unknown>;
}

export const classifyGateway = (registry: ClassifierRegistryLike | undefined): ClassifierGateway | undefined => {
	if (!registry) return undefined;
	return {
		available: async (preference) => {
			try {
				const raw = await (registry.getAvailableOfType as (t: string) => Promise<readonly { provider: string; id: string }[]>)("classifier");
				const models = raw;
				for (const pref of preferenceRefs(preference)) {
					const hit = models.find((m) => m.provider === pref.provider && m.id === pref.id);
					if (hit) return { provider: hit.provider, id: hit.id };
				}
				return models[0] ? { provider: models[0].provider, id: models[0].id } : undefined;
			} catch {
				return undefined;
			}
		},
		classify: async (model, state, questions) => {
			try {
				const physical = (registry.getModelOfType as (t: string, p: string, i: string) => unknown)("classifier", model.provider, model.id);
				if (!physical) return undefined;
				const out = await (registry.classify as (m: unknown, c: unknown) => Promise<unknown>)(physical, { state, questions });
				return out as { answers?: Record<string, HandoffAnswerLike>; stopReason?: string };
			} catch {
				return undefined;
			}
		},
	};
};

export interface DistillGateway {
	distill: (prompt: string) => Promise<string | undefined>;
}

export const distillThenKeep = async (distill: DistillGateway | undefined, decision: KeepDecision, opts: { from: string; text: string; existing: HandoffItem[] }): Promise<string | undefined> => {
	if (!decision.keep) return undefined;
	if (!distill) return opts.text;
	return distill.distill(distillPrompt({ from: opts.from, raw: opts.text }, opts.existing)).catch(() => undefined);
};

export interface SubagentDistillOpts {
	runSubagent: (prompt: string) => Promise<{ ok: boolean; output: string }>;
	parse: (out: string) => string | undefined;
}

export const subagentDistillGateway = (opts: SubagentDistillOpts): DistillGateway => ({
	distill: async (prompt) => {
		const r = await opts.runSubagent(prompt);
		return r.ok ? opts.parse(r.output) : undefined;
	},
});
