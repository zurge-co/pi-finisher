import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { finisherDir } from "./types.ts";
import { HANDOFF_KEY } from "./handoff-model.ts";
import { LADDER_MODEL_ID, LADDER_PROVIDER } from "./ladder-model.ts";
import { SWARM_SLOT_KEYS, ladderPatterns, readModelLadder } from "./swarm.ts";

export const LADDER_SLOT_KEYS = SWARM_SLOT_KEYS;

export interface LadderSlot {
	key: string;
	pattern?: string;
}

export type ModelSource = "slot" | "priority" | "main" | "none";

export interface ResolvedModel {
	pattern?: string;
	source: ModelSource;
}

export const modelsPath = (cwd: string): string => join(finisherDir(cwd), "models.json");

export const ladderVirtualPattern = (): string => `${LADDER_PROVIDER}/${LADDER_MODEL_ID}`;

export const isVirtualLadderPattern = (pattern: string): boolean => pattern.trim().toLowerCase() === ladderVirtualPattern();

export const readModelsFile = (cwd: string): Record<string, unknown> => {
	const f = modelsPath(cwd);
	if (!existsSync(f)) return {};
	try {
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

const expandLegacyPriority = (cfg: Record<string, unknown>): Record<string, unknown> => {
	if (!Array.isArray(cfg.priority)) return cfg;
	const next = { ...cfg };
	ladderPatterns({ priority: cfg.priority }).forEach((pattern, i) => {
		const key = LADDER_SLOT_KEYS[i];
		if (key && next[key] === undefined) next[key] = pattern;
	});
	delete next.priority;
	return next;
};

export const readLadderSlots = (cwd: string): LadderSlot[] => {
	const cfg = expandLegacyPriority(readModelsFile(cwd));
	return LADDER_SLOT_KEYS.map((key) => {
		const v = cfg[key];
		return typeof v === "string" && v.trim() ? { key, pattern: v.trim() } : { key };
	});
};

export const writeLadderSlot = (cwd: string, key: string, pattern: string | null): void => {
	mkdirSync(finisherDir(cwd), { recursive: true });
	const cfg = expandLegacyPriority(readModelsFile(cwd));
	const clean = pattern?.trim();
	if (clean) cfg[key] = clean;
	else delete cfg[key];
	writeFileSync(modelsPath(cwd), JSON.stringify(cfg, null, 2) + "\n");
};

export const ignoredModelKeys = (cwd: string): string[] =>
	Object.keys(readModelsFile(cwd)).filter(
		(k) => !(LADDER_SLOT_KEYS as readonly string[]).includes(k) && k !== "priority" && k !== HANDOFF_KEY,
	);

export const firstLadderPattern = (cwd: string): string | undefined => readModelLadder(cwd)[0];

export const resolveSubagentModel = (cwd: string, opts: { slotModel?: string; mainModel?: string } = {}): ResolvedModel => {
	const slot = opts.slotModel?.trim();
	if (slot) return { pattern: slot, source: "slot" };
	const priority = firstLadderPattern(cwd);
	if (priority) return { pattern: priority, source: "priority" };
	const main = opts.mainModel?.trim();
	if (main) return { pattern: main, source: "main" };
	return { source: "none" };
};

export const modelSourceNote = (resolved: ResolvedModel): string =>
	resolved.source === "priority" ? `auto-picked ${resolved.pattern} from the priority ladder` : `${resolved.pattern ?? "(main model)"}`;

export const availableModelChoices = (ctx: ExtensionContext): { pattern: string; label: string; description: string }[] => {
	try {
		const raw = ctx.scopedModels?.length
			? ctx.scopedModels.map((s) => {
					const base = `${s.model.provider}/${s.model.id}`;
					return {
						pattern: s.thinkingLevel ? `${base}:${s.thinkingLevel}` : base,
						label: s.thinkingLevel ? `${base}:${s.thinkingLevel}` : base,
						description: s.thinkingLevel ? `${s.model.name} (scoped, thinking pinned)` : `${s.model.name} (scoped)`,
					};
				})
			: ctx.modelRegistry.getAvailable().map((m) => ({
					pattern: `${m.provider}/${m.id}`,
					label: `${m.provider}/${m.id}`,
					description: m.name,
				}));
		return raw.filter((c) => !isVirtualLadderPattern(c.pattern));
	} catch {
		return [];
	}
};

export const panelize = <T extends string>(theme: { bg: (color: T, text: string) => string }, lines: string[], w: number): string[] =>
	lines.map((ln) => theme.bg("selectedBg" as T, ln + " ".repeat(Math.max(0, w - visibleWidth(ln)))));
