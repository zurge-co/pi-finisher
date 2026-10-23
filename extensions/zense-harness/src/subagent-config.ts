
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { zenseDir } from "./types.ts";
import { CHECK_FORMAT_CONTRACT } from "./evidence.ts";

export const SUBAGENT_EXCLUDE_TOOLS: Record<string, string[]> = {
	requirements: ["write", "edit"],
	planner: ["write", "edit"],
	grader: ["write", "edit"],
	reviewer: ["write", "edit"],
	distiller: ["write", "edit", "bash"],
	swarm: ["write", "edit"],
};

export const SUBAGENT_STRIP_FLAGS: Record<string, string[]> = {
	requirements: ["--no-themes", "--no-prompt-templates"],
	planner: ["--no-themes", "--no-prompt-templates"],
	swarm: ["--no-themes", "--no-prompt-templates"],
	grader: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
	reviewer: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
	distiller: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
};

export const SUBAGENT_TIMEOUT_MS: Record<string, number> = {
	requirements: 600_000,
	planner: 300_000,
	swarm: 600_000,
	grader: 600_000,
	reviewer: 480_000,
	distiller: 300_000,
	default: 300_000,
};
export const subagentTimeout = (role: string, cwd?: string, fallbackCwd?: string): number => {
	for (const dir of [cwd, fallbackCwd]) {
		if (!dir) continue;
		try {
			const cfgPath = join(zenseDir(dir), "config.json");
			if (!existsSync(cfgPath)) continue;
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { subagentTimeoutMs?: Record<string, number> };
			const v = cfg.subagentTimeoutMs?.[role] ?? cfg.subagentTimeoutMs?.default;
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
		} catch {
		}
	}
	return SUBAGENT_TIMEOUT_MS[role] ?? SUBAGENT_TIMEOUT_MS.default;
};

export const zenseGlobalConfigDir = (): string => join(homedir(), ".pi", "agent", "zense");

export interface InstalledExtension {
	path: string;   	enabled: boolean;
	source: string; 	scope: string;  }

export const extDisplayLabel = (ext: InstalledExtension): string => {
	const segs = ext.path.split(/[\\/]/).filter(Boolean);
	const pkgTail = ext.source.replace(/^npm:/, "").split("/").filter(Boolean).pop() ?? "";
	const idx = pkgTail ? segs.lastIndexOf(pkgTail) : -1;
	const rel = idx >= 0 ? segs.slice(idx + 1) : segs.slice(-1);
	if (rel[0] === "extensions") rel.shift();
	return rel.join("/");
};

export const listInstalledExtensions = async (cwd: string, agentDir = getAgentDir()): Promise<InstalledExtension[]> => {
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const resolved = await pm.resolve(async () => "skip");
		return resolved.extensions.map((e) => ({ path: e.path, enabled: e.enabled, source: e.metadata.source, scope: e.metadata.scope }));
	} catch {
		return [];
	}
};

const readExtIncludesFrom = (cfgPath: string, role: string): string[] | undefined => {
	try {
		if (!existsSync(cfgPath)) return undefined;
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { subagentExtInclude?: Record<string, unknown> };
		const sub = cfg.subagentExtInclude;
		if (!sub || typeof sub !== "object") return undefined;
		const v = sub[role];
		if (!Array.isArray(v)) return undefined;
		return v.filter((p): p is string => typeof p === "string");
	} catch {
		return undefined; 	}
};

export const subagentExtIncludes = (role: string, cwd?: string, fallbackCwd?: string, globalDir = zenseGlobalConfigDir()): string[] => {
	for (const dir of [cwd, fallbackCwd]) {
		if (!dir) continue;
		const v = readExtIncludesFrom(join(zenseDir(dir), "config.json"), role);
		if (v !== undefined) return v;
	}
	return readExtIncludesFrom(join(globalDir, "config.json"), role) ?? [];
};

export const writeSubagentExtIncludes = (cwd: string, role: string, value: string[] | null, globalDir = zenseGlobalConfigDir()): { globalSeeded: boolean } => {
	const writeInto = (cfgPath: string, mutate: (sub: Record<string, unknown>) => void): boolean => {
		try {
			let raw: Record<string, unknown> = {};
			if (existsSync(cfgPath)) raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			const sub = { ...((raw.subagentExtInclude as Record<string, unknown> | undefined) ?? {}) };
			mutate(sub);
			if (Object.keys(sub).length) raw.subagentExtInclude = sub;
			else delete raw.subagentExtInclude;
			mkdirSync(dirname(cfgPath), { recursive: true });
			writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
			return true;
		} catch {
			return false; 		}
	};
	writeInto(join(zenseDir(cwd), "config.json"), (sub) => {
		if (value === null) delete sub[role];
		else sub[role] = value;
	});
	let globalSeeded = false;
	if (value !== null && readExtIncludesFrom(join(globalDir, "config.json"), role) === undefined)
		globalSeeded = writeInto(join(globalDir, "config.json"), (sub) => {
			sub[role] = value;
		});
	return { globalSeeded };
};

export const subagentStripFlagsAsync = async (
	role: string,
	cwd?: string,
	fallbackCwd?: string,
	agentDir = getAgentDir(),
	globalDir = zenseGlobalConfigDir(),
): Promise<string[]> => {
	const base = SUBAGENT_STRIP_FLAGS[role] ?? [];
	const include = subagentExtIncludes(role, cwd, fallbackCwd, globalDir);
	if (!include.length && base.includes("--no-extensions")) return base; 	const enumCwd = cwd ?? fallbackCwd;
	const valid = include.length && enumCwd ? new Set((await listInstalledExtensions(enumCwd, agentDir)).filter((e) => e.enabled).map((e) => e.path)) : new Set<string>();
	const flags = base.filter((f) => f !== "--no-extensions");
	flags.push("--no-extensions");
	for (const p of include) if (valid.has(p)) flags.push("-e", p);
	return flags;
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

export interface ProviderExtHit {
	path: string;
	label: string;
}

const defaultExtSourceReader = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8").slice(0, 400_000);
	} catch {
		return undefined; 	}
};

export const findProviderExtension = (
	providerId: string,
	exts: InstalledExtension[],
	read: (path: string) => string | undefined = defaultExtSourceReader,
): ProviderExtHit | undefined => {
	const pid = providerId.toLowerCase();
	const scored: { ext: InstalledExtension; score: number }[] = [];
	for (const ext of exts) {
		if (!ext.enabled) continue;
		const content = read(ext.path)?.toLowerCase();
		if (!content) continue;
		if (!content.includes("registerprovider") || !content.includes(pid)) continue;
		let score = 0;
		if (/\/provider\//.test(ext.path.replace(/\\/g, "/"))) score += 2;
		if (content.includes(`id: "${pid}"`) || content.includes(`id: '${pid}'`)) score += 1;
		scored.push({ ext, score });
	}
	if (!scored.length) return undefined;
	const max = Math.max(...scored.map((s) => s.score));
	const top = scored.filter((s) => s.score === max);
	if (top.length !== 1) return undefined; 	return { path: top[0].ext.path, label: extDisplayLabel(top[0].ext) };
};

export const mergeExtInclude = (current: string[], path: string): string[] => (current.includes(path) ? current : [...current, path]);

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

export const buildProviderMissingGuidance = (
	role: string,
	providerId: string,
	opts: { hit?: ProviderExtHit; alreadyIncluded?: boolean; autoRetried?: boolean } = {},
): string => {
	const lines = [
		`provider "${providerId}" is unavailable in the sub-agent (${role}) — sub-agents boot with --no-extensions, so the extension providing the main session's provider is never loaded`,
	];
	if (opts.autoRetried && opts.hit) lines.push(`auto-included "${opts.hit.label}" but the provider is still unavailable — configure it yourself:`);
	if (opts.hit && !opts.alreadyIncluded) {
		lines.push(`fix: /zense:ext-config:${role} and tick "${opts.hit.label}"`);
		lines.push(`or: /zense ext-config-show ${role} on ${opts.hit.path}`);
		lines.push(`if it still falls back after inclusion → suspect auth: pi login ${providerId} or set the provider's API-key env var`);
	} else if (opts.hit && opts.alreadyIncluded) {
		lines.push(`extension "${opts.hit.label}" is already included for this role but the provider is still unavailable — suspect auth: pi login ${providerId} or set the provider's API-key env var (review the list with /zense ext-config-show ${role})`);
	} else {
		lines.push(`no extension providing "${providerId}" found among installed extensions — install that provider extension first, or change this role's model with /zense models`);
	}
	return lines.join("\n");
};

export const ZENSE_TOOL_GLOB = "zense_*";

export const withZenseToolGlob = (excludeTools?: string[]): string[] => {
	const base = (excludeTools ?? []).filter((t) => t !== ZENSE_TOOL_GLOB);
	return [ZENSE_TOOL_GLOB, ...base];
};

export const buildSubagentArgv = (task: string, modelPattern?: string, excludeTools?: string[], role?: string, stripFlags?: string[]): string[] => {
	const flags = stripFlags ?? (role ? SUBAGENT_STRIP_FLAGS[role] : undefined);
	const argv = ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json", "--no-session"];
	if (flags?.length) argv.push(...flags);
	if (excludeTools?.length) argv.push("--exclude-tools", withZenseToolGlob(excludeTools).join(","));
	if (modelPattern) argv.push("--model", modelPattern);
	argv.push(task);
	return argv;
};

export const buildRpcSubagentArgs = (excludeTools?: string[], role?: string, stripFlags?: string[]): string[] => {
	const flags = stripFlags ?? (role ? SUBAGENT_STRIP_FLAGS[role] : []);
	return ["--no-session", ...flags, "--exclude-tools", withZenseToolGlob(excludeTools).join(",")];
};

export const buildRequirementsPrompt = (intent: string, lessons: string[], facts?: string[], exemplar?: string | null, timeoutMs = 300_000): string =>
	`You are the REQUIREMENTS sub-agent for a spec-gated SDLC harness. Your single JSON output becomes the machine-checked contract for the main agent's implementation, so every criterion must be grounded in THIS repository's reality — never guess.

` +
	`Step 1 — EXPLORE (read-only, mandatory before drafting): read README*, package.json / other manifests, test configs, CI configs and the relevant source layout. Actually RUN the candidate test/lint/build commands you plan to reference, so every check you write is proven to work here. You have NO write/edit tools — do not attempt to modify anything. You run under a HARD wall-clock limit of about ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes — be economical: never probe toolchains or test commands one-by-one; if the harness-provided facts below already list them, trust the list and move on, otherwise batch ALL probes into ONE bash loop. Never re-run commands the facts already answered, and never run anything likely to exceed ~30s more than once (full test suites, builds, installs): if a candidate check is slow, find a faster equivalent — and if none exists, push that verification into specDebt instead of burning your budget.

` +
	`Step 2 — DRAFT exactly ONE JSON object:
{"title": string, "intent": string, "crossCheck": string[], "outcomes": string, "approach": string[], "scope": string[], "constraints": string[], "criteria": [{"id": string, "text": string, "check": string}], "specDebt": string[]}
Rules:
- crossCheck: REQUIRED. 2–6 SHORT lines, one goal CASE per line, in the SAME LANGUAGE as the Request (a Thai request gets Thai cases, an English request gets English). Each line states one user-visible behavior the request asks for in a checkable shape — e.g. "คุณต้องการให้ A มี B เกิดขึ้นเมื่อ C" / "เมื่อ 1 แล้ว 2 จะหายไป" / "You want A to show B when C". This list is the ENTIRE sign surface: the human reads it to verify you understood the request, case by case. No paragraphs, no technical detail. NEVER use jargon, library names, file paths, file names, shell commands or code.
- outcomes: OPTIONAL legacy plain-language summary (older flows); crossCheck is the sign surface and must be present even when outcomes is also written.
- scope: the minimal list of path prefixes the main agent may modify.
- approach: 3–7 short bullets describing the planned work — main steps, which files will be created or modified, and expected outcomes — grounded in your Step 1 exploration (no guessing). This is presentational info kept in the technical spec file (the sign dialog points to it); it is NOT a machine-checked criterion.
- criteria: few and atomic. Each "check" MUST obey this contract:
  ${CHECK_FORMAT_CONTRACT}
  Good checks: "npm test" · "path exists: src/a.ts" · "path exists: src/a.ts && npm test"
  Bad checks (never write these — they die for infra reasons at eval): "ls appsdev.yaml" (sh does not expand **) · "[[ -f src/a.ts ]]" (bashism) · "grep -q x {file}" (unsubstituted placeholder) · "path exists: src/<module>/x" (placeholder). Anything you cannot verify by running a command belongs in specDebt instead (it becomes forced human review).
- Output ONLY the JSON object — no markdown fences, no commentary.

` +
	`Step 3 — CLARIFY INSTEAD OF GUESSING (grilling loop) — GOAL-ONLY QUESTIONS: only when the request is ambiguous about the OUTCOME the human wants (what the result should be or do, in product/UI terms), and a wrong guess would be costly, do NOT draft yet. You get multiple rounds — each round you are re-run with ALL previous answers appended to the Request — so ask only the 1–2 most decision-critical questions per round instead of dumping every doubt at once, and each question MUST carry 2–6 pickable choices so the human picks instead of writing prose (they can also type their own via "Other"): {"questions": [{"question": "…", "choices": ["option A", "option B"]}]}. A question WITHOUT choices is rejected by the parser unless it is a product/UI-outcome question that genuinely has no guessable options, marked explicitly {"questions": [{"question": "…", "freeText": true}]} (max 5 questions per round; either shape, both may mix in one array).
` +
	`NEVER ask the human an internal technical/detail question — library choice, module split, file layout, naming, test approach, data shape, refactor structure, error-handling style — or ask them to pick an implementation strategy: those are YOUR decisions. Decide them from the repo/context you explored in Step 1, proceed, and record each one as an explicit assumption in the spec's constraints AND a specDebt entry, so the human reviews the choice at signing instead of being asked upfront. Sending such a question is a policy violation and the harness rejects the draft with feedback.
` +
	(exemplar ? `\n\nA previously SIGNED spec from this repo (style/format exemplar — do NOT copy its content):\n${exemplar}` : "") +
	(facts?.length ? `\n\nRepository facts gathered by the harness (verified — trust these over your own assumptions):\n${facts.join("\n")}` : "") +
	(lessons.length
		? `\n\nPast lessons from this project's memory (reflect relevant ones in scope/constraints/criteria when they apply):\n${lessons.join("\n")}`
		: "") +
	`\n\nRequest: ${intent}`;
