export interface EvidenceCommand {
	command: string;
	exitCode?: number;
	output?: string;
	ranAt?: number;
}

export type CaseVerdict = "PASS" | "FAIL" | "UNVERIFIED" | "BLOCKED";

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

export const commandName = (text: string): string | undefined => {
	const cleaned = text.trim().replace(/^(?:\$|>)\s*/, "").replace(/^[-*+\d.|\s]+?[|]\s*/, "").replace(/\*\*/g, "").trim();
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

export const unclaimedStatus = (line: string): boolean => {
	const body = stripFences(line).trim();
	if (!body) return false;
	if (commandsOnLine(body).length) return false;
	const own = body.match(STATUS_BEFORE_EXIT);
	if (!own || !body.match(EXIT_LINE)) return false;
	return own[1].replace(/[*`|\-\s]/g, "").length >= 2;
};

const commandsOnLine = (line: string): Candidate[] => {
	const found: Candidate[] = [];
	const body = stripFences(line);
	if (!body) return found;
	const whole = anchoredCommand(body) ? commandName(body.includes("|") ? body.split("|").slice(1).join(" ") : body) : undefined;
	if (whole) found.push({ command: whole, at: 0, explicit: false });
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
		if (commandsOnLine(line).length || commandShaped(line)) return undefined;
		if (statusInCode(line)) continue;
		const later = stripFences(line).match(EXIT_LINE);
		if (later) return Number(later[1]);
	}
	return undefined;
};

export const extractCommands = (output: string): EvidenceCommand[] => {
	const commands: EvidenceCommand[] = [];
	const seen = new Set<string>();
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const unowned = !pastedSource(lines[i]) && unclaimedStatus(lines[i]);
		for (const cand of [...commandsOnLine(lines[i]), ...(unowned ? [{ command: `(unowned status) ${stripFences(lines[i]).trim().slice(0, 120)}`, at: 0, explicit: true, unowned: true }] : [])]) {
			const exitCode = exitFor(lines, i, cand);
			const key = `${cand.command}=${exitCode ?? "?"}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (commands.length >= 40) return commands;
			const evidence: EvidenceCommand = { command: cand.command };
			if (exitCode !== undefined) evidence.exitCode = exitCode;
			else if (cand.unowned === true) continue;
			const body = lines.slice(i + 1, Math.min(i + 4, lines.length)).map((l) => l.trim()).filter(Boolean).join(" ");
			if (body) evidence.output = body.slice(0, 300);
			commands.push(evidence);
		}
	}
	return commands;
};
