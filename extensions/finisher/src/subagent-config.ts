
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { finisherDir } from "./types.ts";

export const SUBAGENT_ROLES = ["swarm", "verifier"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const isSubagentRole = (role: string): role is SubagentRole => (SUBAGENT_ROLES as readonly string[]).includes(role);

export const SUBAGENT_EXCLUDE_TOOLS: Record<string, string[]> = {
	swarm: [],
	verifier: ["write", "edit"],
};

export const SUBAGENT_STRIP_FLAGS: Record<string, string[]> = {
	swarm: ["--no-themes", "--no-prompt-templates", "--no-mcp", "--no-skills"],
	verifier: ["--no-themes", "--no-prompt-templates", "--no-mcp", "--no-skills"],
};

export const SUBAGENT_TIMEOUT_MS: Record<string, number> = {
	swarm: 600_000,
	verifier: 600_000,
	default: 300_000,
};
export const subagentTimeout = (role: string, cwd?: string, fallbackCwd?: string): number => {
	for (const dir of [cwd, fallbackCwd]) {
		if (!dir) continue;
		try {
			const cfgPath = join(finisherDir(dir), "config.json");
			if (!existsSync(cfgPath)) continue;
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { subagentTimeoutMs?: Record<string, number> };
			const v = cfg.subagentTimeoutMs?.[role] ?? cfg.subagentTimeoutMs?.default;
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
		} catch {
		}
	}
	return SUBAGENT_TIMEOUT_MS[role] ?? SUBAGENT_TIMEOUT_MS.default;
};

export const modelMatchesPattern = (usedModel: string, pattern: string): boolean => {
	const used = usedModel.trim().toLowerCase();
	const pat = pattern.trim().toLowerCase();
	return used.length > 0 && (pat === used || pat.startsWith(`${used}:`));
};

export const providerIdOfModelPattern = (pattern: string): string | undefined => {
	const i = pattern.indexOf("/");
	return i > 0 ? pattern.slice(0, i).trim().toLowerCase() : undefined;
};

export const usedProviderOf = (usedModel?: string): string | undefined => {
	if (!usedModel) return undefined;
	const i = usedModel.indexOf("/");
	return i > 0 ? usedModel.slice(0, i).toLowerCase() : undefined;
};

export const BUILTIN_PROVIDER_IDS = new Set([
	"anthropic", "openai", "openai-codex", "google", "google-vertex", "google-antigravity", "google-gemini-cli",
	"amazon-bedrock", "azure-openai-responses", "openrouter", "groq", "mistral", "xai", "cerebras", "zai",
	"opencode", "opencode-go", "kimi-coding", "minimax", "minimax-cn", "huggingface", "deepseek",
]);

export const PROVIDER_MISSING_RX = /no models found matching|model .{0,60}\bnot available|unknown (model|provider)|no api key found for/i;

export const diagnoseProviderMissing = (
	modelPattern: string | undefined,
	r: { ok: boolean; output: string; usedModel?: string },
): { kind: "provider-mismatch" | "hard-missing"; patternProvider: string } | undefined => {
	if (!modelPattern) return undefined;
	const patternProvider = providerIdOfModelPattern(modelPattern);
	if (!patternProvider || BUILTIN_PROVIDER_IDS.has(patternProvider)) return undefined;
	if (r.usedModel) {
		const usedProv = usedProviderOf(r.usedModel);
		if (usedProv !== patternProvider && !modelMatchesPattern(r.usedModel, modelPattern)) return { kind: "provider-mismatch", patternProvider };
		return undefined;
	}
	if (!r.ok && PROVIDER_MISSING_RX.test(r.output)) return { kind: "hard-missing", patternProvider };
	return undefined;
};

export const buildProviderMissingGuidance = (role: string, providerId: string): string =>
	[
		`provider "${providerId}" is unavailable in the sub-agent (${role}) — that provider is served by an extension that is not installed or not enabled`,
		`fix: install/enable the extension providing "${providerId}", or change this role's model with /finisher models`,
		`if it is installed and enabled, suspect auth: pi login ${providerId} or set the provider's API-key env var`,
	].join("\n");

export const FINISHER_TOOL_GLOB = "finisher_*";

export const withFinisherToolGlob = (excludeTools?: string[]): string[] => {
	const base = (excludeTools ?? []).filter((t) => t !== FINISHER_TOOL_GLOB);
	return [FINISHER_TOOL_GLOB, ...base];
};

export const buildSubagentArgv = (task: string, modelPattern?: string, excludeTools?: string[], role?: string, stripFlags?: string[]): string[] => {
	const flags = stripFlags ?? (role ? SUBAGENT_STRIP_FLAGS[role] : undefined);
	const argv = ["PI_FINISHER_SUBAGENT=1", "pi", "--mode", "json"];
	if (flags?.length) argv.push(...flags);
	if (excludeTools?.length) argv.push("--exclude-tools", withFinisherToolGlob(excludeTools).join(","));
	if (modelPattern) argv.push("--model", modelPattern);
	argv.push(task);
	return argv;
};

export const buildRpcSubagentArgs = (excludeTools?: string[], role?: string, stripFlags?: string[]): string[] => {
	const flags = stripFlags ?? (role ? SUBAGENT_STRIP_FLAGS[role] : []);
	return [...flags, "--exclude-tools", withFinisherToolGlob(excludeTools).join(",")];
};


export const LADDER_KEY_RX = /^priority([1-5]?|)$/;

export const isLadderKey = (key: string): boolean => LADDER_KEY_RX.test(key) || key === "priority";
