import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir } from "./types.ts";

export const SURFACE_TOOLS = ["zense_goal", "zense_swarm", "zense_steer"] as const;
export const RETIRED_TOOLS = ["zense_spec", "zense_adr", "zense_eval", "zense_review", "zense_accept", "zense_discard", "zense_longrun", "zense_ask"] as const;
export const SURFACE_COMMANDS = ["models"] as const;
export const RETIRED_COMMANDS = ["approve", "gate", "longrun", "memory", "ext-config-show", "distill", "resume", "status", "accept", "discard", "agents", "fresh-context", "surface"] as const;
export const APPLY_BACK_COMMANDS: readonly string[] = [];

export interface ConfigSurface {
	priority: string[];
	swarmConcurrency?: number;
	subagentTimeoutMs?: Record<string, number>;
	ignoredKeys: string[];
}

const COST_KEYS = ["maxTokens", "budget", "costLimit", "tokenCeiling", "maxCost"];

const readJson = (file: string): Record<string, unknown> => {
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

export const readConfigSurface = (cwd: string): ConfigSurface => {
	const dir = zenseDir(cwd);
	const models = readJson(join(dir, "models.json"));
	const config = readJson(join(dir, "config.json"));
	const rawPriority = Array.isArray(models.priority) ? models.priority : [];
	const priority = rawPriority
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean)
		.filter((v, i, all) => all.indexOf(v) === i)
		.slice(0, 5);
	const concurrency = typeof config.swarmConcurrency === "number" && config.swarmConcurrency >= 1 ? Math.floor(config.swarmConcurrency) : undefined;
	const timeouts = config.subagentTimeoutMs && typeof config.subagentTimeoutMs === "object" && !Array.isArray(config.subagentTimeoutMs) ? (config.subagentTimeoutMs as Record<string, number>) : undefined;
	const ignoredKeys = [...Object.keys(models), ...Object.keys(config)].filter((k) => COST_KEYS.includes(k));
	return {
		priority,
		...(concurrency === undefined ? {} : { swarmConcurrency: concurrency }),
		...(timeouts === undefined ? {} : { subagentTimeoutMs: timeouts }),
		ignoredKeys,
	};
};

export const costCeilingKeysPresent = (cwd: string): string[] => readConfigSurface(cwd).ignoredKeys;

export const isRetiredTool = (name: string): boolean => (RETIRED_TOOLS as readonly string[]).includes(name);

export const isLiveTool = (name: string): boolean => (SURFACE_TOOLS as readonly string[]).includes(name);

export const surfaceLine = (cwd: string): string => {
	const cfg = readConfigSurface(cwd);
	return [
		`tools: ${SURFACE_TOOLS.join(", ")}`,
		`commands: /zense ${SURFACE_COMMANDS.join(" | ")}`,
		`model ladder: ${cfg.priority.length ? cfg.priority.join(" > ") : "(main session model only)"}`,
		`concurrency: ${cfg.swarmConcurrency ?? "auto (as many slots as configured)"}`,
		`token/cost ceiling: none${cfg.ignoredKeys.length ? ` (ignored keys: ${cfg.ignoredKeys.join(", ")})` : ""}`,
	].join("\n");
};
