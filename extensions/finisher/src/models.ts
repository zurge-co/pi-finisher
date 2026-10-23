
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { finisherDir } from "./types.ts";

export const readModelsConfig = (cwd: string): Record<string, string> => {
	const f = join(finisherDir(cwd), "models.json");
	if (!existsSync(f)) return {};
	try {
		const raw = JSON.parse(readFileSync(f, "utf8"));
		if (raw && typeof raw === "object") {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
			return out;
		}
	} catch {
	}
	return {};
};

export const resolveModelPattern = (cwd: string, role: string, mainModel?: { provider: string; id: string }): string | undefined => {
	const cfg = readModelsConfig(cwd);
	const configured = cfg[role];
	if (configured) return configured;
	if (mainModel) return `${mainModel.provider}/${mainModel.id}`;
	return undefined;
};

export const writeModelsConfig = (cwd: string, role: string, pattern: string | null): void => {
	const dir = finisherDir(cwd);
	mkdirSync(dir, { recursive: true });
	const f = join(dir, "models.json");
	let cfg: Record<string, unknown> = {};
	if (existsSync(f)) {
		try {
			const raw = JSON.parse(readFileSync(f, "utf8"));
			if (raw && typeof raw === "object") cfg = raw as Record<string, unknown>;
		} catch {
		}
	}
	if (pattern && pattern.trim()) cfg[role] = pattern.trim();
	else delete cfg[role];
	writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
};

export const availableModelChoices = (ctx: ExtensionContext): { pattern: string; label: string; description: string }[] => {
	try {
		if (ctx.scopedModels?.length) {
			return ctx.scopedModels.map((s) => {
				const base = `${s.model.provider}/${s.model.id}`;
				const pattern = s.thinkingLevel ? `${base}:${s.thinkingLevel}` : base;
				return {
					pattern,
					label: pattern,
					description: s.thinkingLevel ? `${s.model.name} (scoped, thinking pinned)` : `${s.model.name} (scoped)`,
				};
			});
		}
		return ctx.modelRegistry.getAvailable().map((m) => ({
			pattern: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.id}`,
			description: m.name,
		}));
	} catch {
		return [];
	}
};

export const panelize = <T extends string>(theme: { bg: (color: T, text: string) => string }, lines: string[], w: number): string[] =>
	lines.map((ln) => theme.bg("selectedBg" as T, ln + " ".repeat(Math.max(0, w - visibleWidth(ln)))));
