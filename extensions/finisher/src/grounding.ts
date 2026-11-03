import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readPackage } from "./verify-checks.ts";

export interface GroundGap {
	kind: "path" | "script";
	token: string;
}

export interface Grounding {
	gaps: GroundGap[];
	checked: number;
}

export const GROUND_GAP_MAX = 40;

const CREATION =
	/\b(?:create[sd]?|creating|add(?:s|ed|ing)?|new|introduce[sd]?|scaffold(?:s|ed|ing)?|generate[sd]?|writing|write|rename[sd]?)\b|สร้าง|เพิ่ม|เขียน|ใหม่|เปลี่ยนชื่อ/iu;

const EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|json|jsonl|md|mdx|css|scss|sass|html|toml|yaml|yml|sh|bash|zsh|sql|proto|lock|txt|env|gitignore)$/i;

const TICKED = /`([^`\n]+)`/g;

const BARE_PATH =
	/(?:^|[\s"'([{])(\/(?:[\w@.-]+\/)+[\w@.-]+|\.{1,2}\/(?:[\w@.-]+\/)*[\w@.-]+|(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z][\w-]*)/g;

const SCRIPT_CALL =
	/(?:^|[\s;&|(`])((?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+(?:(?:--?[\w-]+)\s+)*)?([A-Za-z][\w:-]*))/g;

export const NPM_BUILTIN: ReadonlySet<string> = new Set([
	"install",
	"i",
	"ci",
	"uninstall",
	"remove",
	"rm",
	"add",
	"exec",
	"dlx",
	"x",
	"create",
	"init",
	"publish",
	"link",
	"pack",
	"audit",
	"update",
	"outdated",
	"why",
	"list",
	"ls",
	"view",
	"info",
	"search",
	"login",
	"logout",
	"config",
	"cache",
	"fund",
	"doctor",
	"help",
	"version",
	"dedupe",
	"prune",
	"ping",
	"completion",
	"token",
	"owner",
	"access",
	"team",
	"org",
	"profile",
	"bugs",
	"docs",
	"home",
	"star",
	"stars",
	"whoami",
]);

const trimToken = (token: string): string => token.replace(/^["'`(]+|["'`)\]}.,:;]+$/g, "").replace(/^\.\//, "").trim();

export const pathToken = (raw: string): string | undefined => {
	const token = trimToken(raw);
	if (!token || /\s/.test(token)) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(token) && !/^[a-z]:[\\/]/i.test(token)) return undefined;
	if (/^(?:@|~\/|\.\.\.|…|\$)/.test(token)) return undefined;
	if (/[*?{}<>$…]/.test(token)) return undefined;
	if (token.startsWith("-") || token === "." || token === "..") return undefined;
	return token;
};

const pathShaped = (token: string): boolean => token.includes("/") || EXTENSIONS.test(token);

export const pathTokens = (text: string): string[] => {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of String(text ?? "").matchAll(TICKED)) {
		const token = pathToken(match[1]);
		if (!token || !pathShaped(token) || seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	for (const match of String(text ?? "").matchAll(BARE_PATH)) {
		const token = pathToken(match[1]);
		if (!token || seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
};

export const scriptTokens = (text: string): string[] => {
	const out: string[] = [];
	for (const match of String(text ?? "").matchAll(SCRIPT_CALL)) {
		const call = match[1];
		const manager = call.split(/\s+/)[0];
		const name = match[2];
		if (!name) continue;
		const runs = /\brun(?:-script)?\b/.test(call);
		if (manager === "bun" && !runs) continue;
		if (manager !== "bun" && !runs && NPM_BUILTIN.has(name)) continue;
		if (!out.includes(name)) out.push(name);
	}
	return out;
};

export const pathBases = (cwd: string, texts: string[]): string[] => {
	const out = [cwd];
	for (const text of texts)
		for (const match of String(text ?? "").matchAll(/(?:^|[\s;&(])cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
			const dir = match[1].replace(/^["']|["']$/g, "");
			if (!dir || dir.startsWith("-") || /[*?$]/.test(dir)) continue;
			const full = isAbsolute(dir) ? dir : join(cwd, dir);
			if (!out.includes(full)) out.push(full);
		}
	return out;
};

const existsIn = (bases: string[], token: string): boolean => bases.some((base) => existsSync(isAbsolute(token) ? token : join(base, token)));

export const groundPlan = (cwd: string, texts: string[]): Grounding => {
	const lines = (Array.isArray(texts) ? texts : []).map((text) => String(text ?? "")).filter(Boolean);
	const bases = pathBases(cwd, lines);
	const creates = lines.map((line) => CREATION.test(line));
	const packages = bases.map((base) => readPackage(base)).filter((pkg): pkg is NonNullable<typeof pkg> => !!pkg);
	const scripts = packages.length ? new Set(packages.flatMap((pkg) => Object.keys(pkg.scripts ?? {}))) : undefined;
	const created = new Set<string>();
	for (const [at, line] of lines.entries())
		if (creates[at]) for (const token of [...pathTokens(line), ...scriptTokens(line)]) created.add(token);
	const gaps: GroundGap[] = [];
	const seen = new Set<string>();
	let checked = 0;
	for (const [at, line] of lines.entries()) {
		for (const token of pathTokens(line)) {
			if (!token.includes("/") && !isAbsolute(token)) continue;
			checked += 1;
			const key = `path:${token}`;
			if (seen.has(key) || creates[at] || created.has(token)) continue;
			if (existsIn(bases, token)) continue;
			seen.add(key);
			gaps.push({ kind: "path", token });
		}
		for (const name of scriptTokens(line)) {
			if (!scripts) continue;
			checked += 1;
			const key = `script:${name}`;
			if (seen.has(key) || creates[at] || created.has(name)) continue;
			if (scripts.has(name)) continue;
			seen.add(key);
			gaps.push({ kind: "script", token: name });
		}
	}
	return { gaps: gaps.slice(0, GROUND_GAP_MAX), checked };
};

export const groundingNote = (grounding: Grounding): string =>
	grounding.gaps.length
		? [
				`⚠ ${grounding.gaps.length} name(s) here are not in the repo:`,
				...grounding.gaps.map((gap) =>
					gap.kind === "path" ? `  ${gap.token} — no such path` : `  \`npm run ${gap.token}\` — package.json has no "${gap.token}" script`,
				),
				"read what they point at and fix the plan, or say the lap creates them. A plan built on names the repo does not have is what comes back as a fix lap at verify.",
			].join("\n")
		: "";
