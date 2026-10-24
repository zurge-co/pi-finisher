export const UNOWNED_PREFIX = "(unowned status) ";

export const OUTPUT_INDENT = /^\s{2,}\S/;
const PURE_STATUS = /^\s*(?:exit(?:ed)?(?:\s*(?:code|status))?\s*[:=]?\s*-?\d{1,3}|EXIT\s*=\s*-?\d{1,3})\s*$/i;

export interface EvidenceCommand {
	command: string;
	exitCode?: number;
	output?: string;
	ranAt?: number;
}

export type CaseVerdict = "PASS" | "FAIL" | "UNVERIFIED" | "BLOCKED" | "HUMAN";

export const INFRA_MARKERS: ReadonlyArray<RegExp> = [
	/sub-agent rpc error/i,
	/Unknown provider/i,
	/\bTIMEOUT \d+s\b/,
	/cancelled by user/i,
	/the sub-agent never came up/i,
	/\bENOENT\b/,
	/\bEACCES\b/,
	/provider(?:_| )missing/i,
	/no model to run/i,
];

export const infraFailure = (output: string): string | undefined => {
	for (const line of output.split("\n")) {
		if (!INFRA_MARKERS.some((m) => m.test(line))) continue;
		if (/VERDICT:\s*(PASS|FAIL|UNVERIFIED)/i.test(line)) continue;
		return line.trim().slice(0, 200);
	}
	return undefined;
};

export const declaredVerdict = (output: string): CaseVerdict | undefined => {
	const matches = [...output.matchAll(/VERDICT:\s*(PASS|FAIL|UNVERIFIED)\b/gi)];
	if (!matches.length) return undefined;
	return matches[matches.length - 1][1].toUpperCase() as CaseVerdict;
};

export const COMMAND_BINARIES = ["npm", "npx", "pnpm", "yarn", "bun", "deno", "node", "python", "python3", "pytest", "go", "cargo", "make", "tsc", "vitest", "jest", "npx"] as const;
const COMMAND_START = new RegExp(`^(?:${COMMAND_BINARIES.join("|")})(?![\\w-])`);
const EXIT_LINE = /\bexit(?:ed)?(?:\s*(?:code|status))?\s*[:=]?\s*(-?\d+)\b/i;
const EXIT_CELL_BARE = /^-?\d{1,3}$/;
const EXIT_CELL_LABELLED = /^exit(?:ed)?(?:\s*(?:code|status))?\s*[:=]?\s*(-?\d{1,3})$/i;

export const cellExitCode = (cell: string): number | undefined => {
	const cleaned = cell.replace(/[*`]/g, "").trim();
	if (EXIT_CELL_BARE.test(cleaned)) return Number(cleaned);
	const labelled = cleaned.match(EXIT_CELL_LABELLED);
	return labelled ? Number(labelled[1]) : undefined;
};

const TRAILING_STATUS = /\s*(?:\u2192|->|\u2794|\u2014|\u2013|-{1,2}|\|)?\s*(?:exit(?:ed)?(?:(?:\s*(?:code|status))?\s*[:=]?)|EXIT\s*=)\s*-?\d{1,3}\b.*$/i;
const SEPARATOR_ONLY = /[\s\u2192\u2794\u2014\u2013|=\-]+$/;

export const commandName = (text: string): string | undefined => {
	const cleaned = text
		.trim()
		.replace(/^(?:\$|>)\s*/, "")
		.replace(/^[-*+\d.|\s]+?[|]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(TRAILING_STATUS, "")
		.replace(SEPARATOR_ONLY, "")
		.trim();
	return COMMAND_START.test(cleaned) ? cleaned : undefined;
};

export const commandShaped = (line: string): boolean => commandName(stripFences(line)) !== undefined;

interface Candidate {
	command: string;
	at: number;
	explicit: boolean;
	unowned?: boolean;
}

const cellIndexAt = (line: string, at: number): number => {
	let seen = 0;
	let pos = 0;
	for (const cell of line.split("|")) {
		if (at <= pos + cell.length) return seen;
		pos += cell.length + 1;
		seen += 1;
	}
	return seen;
};

export const stripFences = (line: string): string => (/^\s*```/.test(line) ? "" : line);

export const STATUS_BEFORE_EXIT = /^(.*?)\bexit(?:ed)?(?:\s*(?:code|status))?\s*[:=]?\s*-?\d{1,3}\b/i;

const NUMBERED_DUMP = /^\s*\d{1,5}\s*[:\t]/;
const TAB_INDENT = /^ *\t/;
const CODE_TEXT = /\b(?:const|let|var|function|return|await|import|export|new|typeof|class|undefined)\b|=>|\w+\(|[{}]|\.\w+\s*=[^=]/;

export const pastedSource = (line: string): boolean => {
	const body = stripFences(line);
	if (!body.trim()) return false;
	if (NUMBERED_DUMP.test(body) || TAB_INDENT.test(body)) return true;
	return CODE_TEXT.test(body);
};

const ANCHORED = /^\s*[$>]|^\S/;

export const anchoredCommand = (line: string): boolean => ANCHORED.test(stripFences(line));

export const statusInCode = (line: string): boolean => {
	const body = stripFences(line);
	if (!pastedSource(body)) return false;
	const own = body.match(STATUS_BEFORE_EXIT);
	return own ? own[1].replace(/[\s*`_|>-]/g, "").length > 0 : true;
};

const INVOCATION = /(?:^|[\s`'"(\[])(?:bash|sh|zsh|fish|git|npm|npx|pnpm|yarn|bun|deno|node|python3?|pytest|go|cargo|make|tsc|vitest|jest|curl|wget|rg|grep|find|ls|cat|sed|awk|jq|docker|gh)\s+[\w./~$*"'\-]/;

export const unclaimedStatus = (line: string): boolean => {
	const body = stripFences(line).trim();
	if (!body) return false;
	if (commandsOnLine(body).length) return false;
	const own = body.match(STATUS_BEFORE_EXIT);
	if (!own || !body.match(EXIT_LINE)) return false;
	const owner = own[1];
	if (owner.replace(/[*`|\-\s]/g, "").length < 2) return false;
	return INVOCATION.test(owner);
};

const commandsOnLine = (line: string, strict = false): Candidate[] => {
	const found: Candidate[] = [];
	const body = stripFences(line);
	if (!body) return found;
	const withoutStatus = body.replace(TRAILING_STATUS, "");
	const piped = body.includes("|") ? withoutStatus.split("|").slice(1).join(" ").trim() : "";
	const whole = anchoredCommand(body) ? commandName(piped || withoutStatus) : undefined;
	if (whole) found.push({ command: whole, at: 0, explicit: false });
	if (strict) {
		const leading = body.match(/^`([^`\n]+)`/);
		const first = leading ? commandName(leading[1]) : undefined;
		if (first && !found.some((f) => f.command === first)) found.push({ command: first, at: 0, explicit: true });
		return found;
	}
	for (const m of body.matchAll(/`([^`\n]+)`/g)) {
		const inner = commandName(m[1]);
		if (inner && !found.some((f) => f.command === inner)) found.push({ command: inner, at: m.index ?? 0, explicit: true });
	}
	return found;
};

const exitFor = (lines: string[], index: number, cand: Candidate): number | undefined => {
	const line = lines[index];
	if (cand.unowned) {
		const own = stripFences(line).match(EXIT_LINE);
		return own ? Number(own[1]) : undefined;
	}
	const same = line.slice(cand.at).match(EXIT_LINE);
	if (same) return Number(same[1]);
	if (line.includes("|")) {
		const from = cellIndexAt(line, cand.at);
		for (const cell of line.split("|").slice(from + 1)) {
			const code = cellExitCode(cell);
			if (code !== undefined) return code;
		}
	}
	for (const line of lines.slice(index + 1, Math.min(index + 4, lines.length))) {
		if (OUTPUT_INDENT.test(line) && !PURE_STATUS.test(stripFences(line))) return undefined;
		if (commandsOnLine(line).length || commandShaped(line)) return undefined;
		if (statusInCode(line)) continue;
		const later = stripFences(line).match(EXIT_LINE);
		if (later) return Number(later[1]);
	}
	return undefined;
};

export const EVIDENCE_MARKER = /^[\s#>*_`\-]*EVIDENCE[\s*_`]*:?[\s*_`]*$/i;
const VERDICT_LINE = /^\s*VERDICT\s*:/i;

export const evidenceRegion = (output: string): string => {
	const lines = output.split("\n");
	const start = lines.findIndex((l) => EVIDENCE_MARKER.test(l));
	if (start < 0) return output;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++)
		if (VERDICT_LINE.test(lines[i])) {
			end = i;
			break;
		}
	return lines.slice(start + 1, end).join("\n");
};

export const extractCommands = (output: string): EvidenceCommand[] => {
	const named = new Map<string, EvidenceCommand>();
	const region = evidenceRegion(output);
	const declared = region !== output;
	if (!declared && declaredVerdict(output)) return [];
	const lines = region.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (OUTPUT_INDENT.test(lines[i])) continue;
		for (const cand of commandsOnLine(lines[i], declared)) {
			const exitCode = exitFor(lines, i, cand);
			const key = cand.unowned === true ? `${cand.command}=?` : cand.command;
			const prior = named.get(key);
			if (prior && !(cand.unowned === true && exitCode === undefined)) {
				const body = lines.slice(i + 1, Math.min(i + 4, lines.length)).map((l) => l.trim()).filter(Boolean).join(" ");
				if (exitCode !== undefined) prior.exitCode = exitCode;
				if (body) prior.output = body.slice(0, 300);
				continue;
			}
			if (prior) continue;
			const evidence: EvidenceCommand = { command: cand.command };
			if (exitCode !== undefined) evidence.exitCode = exitCode;
			else if (cand.unowned === true) continue;
			const body = lines.slice(i + 1, Math.min(i + 4, lines.length)).map((l) => l.trim()).filter(Boolean).join(" ");
			if (body) evidence.output = body.slice(0, 300);
			named.set(key, evidence);
			if (named.size >= 40) return [...named.values()];
		}
	}
	return [...named.values()];
};
