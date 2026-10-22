export const HYGIENE_MAX_LINES = 500;
export const HYGIENE_EXEMPT = "zense-hygiene-allow";

export interface HygieneViolation {
	path: string;
	kind: "comment" | "length" | "exempt-without-reason";
	line?: number;
	detail: string;
}

export interface HygieneOptions {
	maxLines?: number;
	exemptMarker?: string;
}

export interface HygieneIgnored {
	path: string;
	line: number;
	reason?: string;
}

interface CommentRule {
	name: string;
	regexes: RegExp[];
	tokenized?: boolean;
}

const cFamily = (): CommentRule => ({ name: "c", regexes: [], tokenized: true });

const slashRule: CommentRule = { name: "slash", regexes: [/^\s*\/\/.*$/] };

const hashRule: CommentRule = { name: "hash", regexes: [/^\s*#(?!\!)/] };

const dashRule: CommentRule = { name: "dash", regexes: [/^\s*--.*$/] };

const semicolonRule: CommentRule = { name: "semicolon", regexes: [/^\s*;.*$/] };

const percentRule: CommentRule = { name: "percent", regexes: [/^\s*%.*$/] };

const RULES: Record<string, CommentRule> = {
	".ts": cFamily(),
	".tsx": cFamily(),
	".js": cFamily(),
	".jsx": cFamily(),
	".mjs": cFamily(),
	".cjs": cFamily(),
	".mts": cFamily(),
	".cts": cFamily(),
	".java": cFamily(),
	".kt": cFamily(),
	".kts": cFamily(),
	".go": cFamily(),
	".rs": cFamily(),
	".swift": cFamily(),
	".scala": cFamily(),
	".groovy": cFamily(),
	".dart": cFamily(),
	".php": cFamily(),
	".css": cFamily(),
	".scss": cFamily(),
	".sh": hashRule,
	".bash": hashRule,
	".zsh": hashRule,
	".py": hashRule,
	".rb": hashRule,
	".r": hashRule,
	".pl": hashRule,
	".ex": hashRule,
	".exs": hashRule,
	".nim": hashRule,
	".jl": hashRule,
	".yml": hashRule,
	".yaml": hashRule,
	".toml": hashRule,
	".sql": dashRule,
	".lua": dashRule,
	".hs": dashRule,
	".elm": dashRule,
	".clj": semicolonRule,
	".cljs": semicolonRule,
	".lisp": semicolonRule,
	".el": semicolonRule,
	".ini": semicolonRule,
	".tex": percentRule,
};

export const hygieneLanguage = (path: string): string | undefined => {
	const lower = path.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return undefined;
	return RULES[lower.slice(dot)] ? lower.slice(dot) : undefined;
};

export const isHygieneChecked = (path: string): boolean => hygieneLanguage(path) !== undefined;

const reasonOf = (line: string, marker: string): string | undefined => {
	const idx = line.indexOf(marker);
	if (idx < 0) return undefined;
	const after = line.slice(idx + marker.length).replace(/^[\s:——-]+/, "").trim();
	return after || undefined;
};

const lineHasComment = (line: string, rule: CommentRule, block: { open: boolean }): boolean => {
	if (!rule.tokenized) return rule.regexes.some((r) => r.test(line));
	const opened = block.open;
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const next = line[i + 1];
		if (block.open) {
			if (ch === "*" && next === "/") {
				block.open = false;
				i++;
			} else if (ch === undefined) break;
			continue;
		}
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && next === "/") return true;
		if (ch === "/" && next === "*") {
			const close = line.indexOf("*/", i + 2);
			if (close < 0) block.open = true;
			else i = close + 1;
			return true;
		}
	}
	return opened || block.open;
};

export const scanComments = (text: string, path: string, opts: HygieneOptions = {}): { violations: HygieneViolation[]; ignored: HygieneIgnored[] } => {
	const lang = hygieneLanguage(path);
	const violations: HygieneViolation[] = [];
	const ignored: HygieneIgnored[] = [];
	if (!lang) return { violations, ignored };
	const rule = RULES[lang];
	const marker = opts.exemptMarker ?? HYGIENE_EXEMPT;
	const block = { open: false };
	text.split("\n").forEach((line, i) => {
		const hit = lineHasComment(line, rule, block);
		if (!hit) return;
		const reason = reasonOf(line, marker);
		if (reason !== undefined) ignored.push({ path, line: i + 1, reason });
		else if (line.includes(marker)) violations.push({ path, kind: "exempt-without-reason", line: i + 1, detail: `${marker} needs a reason after it` });
		else violations.push({ path, kind: "comment", line: i + 1, detail: `comment in ${lang} source: ${line.trim().slice(0, 80)}` });
	});
	return { violations, ignored };
};

export const countLines = (text: string): number => {
	if (!text) return 0;
	const lines = text.split("\n");
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
};

export const scanLength = (text: string, path: string, opts: HygieneOptions = {}): HygieneViolation[] => {
	if (!isHygieneChecked(path)) return [];
	const max = opts.maxLines ?? HYGIENE_MAX_LINES;
	const total = countLines(text);
	if (total <= max) return [];
	const marker = opts.exemptMarker ?? HYGIENE_EXEMPT;
	const exemptLine = text.split("\n").find((l) => l.includes(marker));
	if (exemptLine) {
		const reason = reasonOf(exemptLine, marker);
		return reason ? [] : [{ path, kind: "exempt-without-reason", detail: `${marker} needs a reason after it` }];
	}
	return [{ path, kind: "length", detail: `${total} lines > ${max} — split this file (a fresh file must fit in one read)` }];
};

export const scanSource = (text: string, path: string, opts: HygieneOptions = {}) => {
	const comments = scanComments(text, path, opts);
	return {
		violations: [...comments.violations, ...scanLength(text, path, opts)],
		ignored: comments.ignored,
		lines: countLines(text),
	};
};

export const formatHygieneViolations = (violations: HygieneViolation[], limit = 20, files = 12): string => {
	if (!violations.length) return "";
	const byFile = new Map<string, HygieneViolation[]>();
	for (const v of violations) {
		const list = byFile.get(v.path) ?? [];
		list.push(v);
		byFile.set(v.path, list);
	}
	const out: string[] = [`${violations.length} code-hygiene violation(s) in ${byFile.size} file(s)`, "rules: no comments in code, no file over 500 lines"];
	let shown = 0;
	for (const [path, list] of byFile) {
		if (shown >= limit) break;
		out.push(`${path} — ${list.length} violation(s)`);
		for (const v of list) {
			if (shown >= limit) break;
			out.push(`   ${v.line ? `line ${v.line}: ` : ""}${v.detail}`);
			shown++;
		}
	}
	if (byFile.size > files) out.push(`… and ${byFile.size - files} more file(s)`);
	if (shown < violations.length) out.push(`… and ${violations.length - shown} more violation(s)`);
	return out.join("\n");
};

export const buildCodeRulesPrompt = (): string =>
	[
		"Code rules for everything you write (enforced by the harness after your edit):",
		"- No comments in code: no line comments and no block comments. Names and structure carry the intent. Only a load-bearing reason may stay, and it must carry the marker " +
			`${HYGIENE_EXEMPT}: <why>.`,
		`- A file you create or rewrite must stay at or under ${HYGIENE_MAX_LINES} lines; split it instead of growing past that.`,
		"- Tests are proof, not coverage. Write the few that establish a real property — a bound holds for every input, an ordering is total, a boundary is exact, an invariant survives a transformation — and skip whatever only re-states the code. A test that would still pass if the logic were wrong is worse than no test.",
		"- Prefer one property that must hold over many examples that merely happen to: name the property in the test, assert the law, not the screenplay.",
		"- Code rules never override a result: they are how the code must be written, not what it may do.",
	].join("\n");

export const CODE_HYGIENE_GUIDELINE = buildCodeRulesPrompt();
