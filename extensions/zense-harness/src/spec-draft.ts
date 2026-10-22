
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Criterion } from "./types.ts";
import { hasUnsubstitutedPlaceholder } from "./evidence.ts";

export interface SpecDraft {
	title: string;
	intent: string;
		crossCheck?: string[];
		outcomes?: string;
	approach: string[];
	scope: string[];
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];
}

export interface ClarifyQuestion {
	question: string;
	choices: string[];
	freeText?: boolean;
}

export const QUESTION_POLICY =
	"Ask ONLY product/UI-outcome questions — what the human wants the result to be or do — each with 2–6 pickable choices. " +
	'Never ask internal technical/detail questions (library, module split, naming, test approach, data shape, refactor structure): decide those from the repo/context, proceed, and record the decision as an explicit assumption plus a specDebt entry. ' +
	'Choices may be omitted only for a product/UI question with genuinely no guessable options, and then the question MUST set "freeText": true.';

export const MAX_CLARIFY_CHOICES = 6;

export interface ClarifyScan {
	questions: ClarifyQuestion[];
	violations: string[];
}

export type DraftParse =
	| { kind: "spec"; draft: SpecDraft }
	| { kind: "clarify"; questions: ClarifyQuestion[] }
	| { kind: "error"; error: string };

const asStringArray = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;

export const asCaseLines = (v: unknown): string[] | undefined => {
	const arr = asStringArray(v);
	if (!arr) return undefined;
	const lines = arr.map((x) => x.replace(/\s*\n+\s*/g, " ").trim()).filter(Boolean);
	return lines.length ? lines : undefined;
};

export const scanClarifyQuestions = (v: unknown): ClarifyScan => {
	const questions: ClarifyQuestion[] = [];
	const violations: string[] = [];
	if (!Array.isArray(v)) return { questions, violations };
	const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);
	for (const x of v) {
		if (typeof x === "string") {
			const q = x.trim();
			if (q) violations.push(`"${short(q)}" — bare question string with no choices (attach 2–6 choices, or add "freeText": true for a product/UI question with no guessable options)`);
			continue;
		}
		if (!x || typeof x !== "object" || Array.isArray(x)) continue;
		const o = x as Record<string, unknown>;
		const q = typeof o.question === "string" ? o.question.trim() : "";
		if (!q) continue;
		const choices = (asStringArray(o.choices) ?? []).slice(0, MAX_CLARIFY_CHOICES);
		if (choices.length) questions.push({ question: q, choices });
		else if (o.freeText === true) questions.push({ question: q, choices: [], freeText: true });
		else violations.push(`"${short(q)}" — no choices and no "freeText": true (a question without options is only legal for a product/UI-outcome question that genuinely has no guessable options)`);
	}
	return { questions, violations };
};

export const asClarifyQuestions = (v: unknown): ClarifyQuestion[] | undefined => {
	const { questions } = scanClarifyQuestions(v);
	return questions.length ? questions : undefined;
};

export const questionPolicyError = (violations: string[]): string =>
	`question policy violation — ${QUESTION_POLICY} Rejected: ${violations.join("; ")}`;

export const extractJsonObject = (text: string): unknown => {
	const candidates: string[] = [text.trim()];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {
		}
	}
	return undefined;
};

export const parseSpecDraft = (text: string): DraftParse => {
	const raw = extractJsonObject(text);
	if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { kind: "error", error: "output is not a JSON object (no parseable JSON found — the prompt instructs output ONLY JSON)" };
	const o = raw as Record<string, unknown>;
	const scan = scanClarifyQuestions(o.questions);
	if (o.questions !== undefined && o.criteria === undefined) {
		if (scan.violations.length) return { kind: "error", error: questionPolicyError(scan.violations) };
		if (scan.questions.length) return { kind: "clarify", questions: scan.questions.slice(0, 5) };
	}
	if (!Array.isArray(o.criteria) || o.criteria.length === 0)
		return { kind: "error", error: "criteria must be an array with at least 1 item (each needs a check that is a runnable command)" };
	const criteria: Criterion[] = [];
	for (let i = 0; i < o.criteria.length; i++) {
		const c = o.criteria[i] as Record<string, unknown> | null;
		if (!c || typeof c !== "object") return { kind: "error", error: `criteria[${i}] is not an object` };
		const ctext = typeof c.text === "string" ? c.text.trim() : "";
		const check = typeof c.check === "string" ? c.check.trim() : "";
		if (!ctext) return { kind: "error", error: `criteria[${i}].text is empty or not a string` };
		if (!check) return { kind: "error", error: `criteria[${i}].check is empty or not a string` };
		criteria.push({ id: typeof c.id === "string" && c.id.trim() ? c.id.trim() : `c${i + 1}`, text: ctext, check });
	}
	const crossCheck = asCaseLines(o.crossCheck);
	return {
		kind: "spec",
		draft: {
			title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "untitled",
			intent: typeof o.intent === "string" ? o.intent : "",
			...(crossCheck ? { crossCheck } : {}),
			outcomes: typeof o.outcomes === "string" && o.outcomes.trim() ? o.outcomes.trim() : undefined,
			approach: asStringArray(o.approach) ?? [],
			scope: asStringArray(o.scope) ?? [],
			constraints: asStringArray(o.constraints) ?? [],
			criteria,
			specDebt: asStringArray(o.specDebt) ?? [],
		},
	};
};

export const isMachineCheckable = (check: string): boolean => {
	const s = check.toLowerCase();
	if (/\bmanual(ly)?\b|by eye|visually|eyeball|ask (the )?human/.test(s)) return false;
	if (/path exists|file exists|exists:/.test(s)) return true;
	if (/`[^`]+`/.test(check) || /^\s*\$/.test(check)) return true;
	return /\b(npm|pnpm|yarn|bun|npx|node|deno|pytest|python3?|pip|cargo|go|make|just|mvn|gradle|dotnet|composer|php|ruby|bundle|bash|sh|zsh|curl|wget|git|grep|rg|ls|cat|head|tail|find|test|diff|cmp|wc|jq|yq|stat|tsc|vitest|jest|mocha|uv|turbo|docker)\b/i.test(check);
};

const tokenSet = (s: string): Set<string> =>
	new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

export const jaccard = (a: Set<string>, b: Set<string>): number => {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
};

export const findSimilarSpec = (cwd: string, draft: SpecDraft): { file: string; title: string; score: number } | null => {
	const dir = join(zenseDir(cwd), "specs");
	if (!existsSync(dir)) return null;
	const mine = tokenSet(`${draft.title} ${draft.intent}`);
	let best: { file: string; title: string; score: number } | null = null;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).slice(-20)) {
		try {
			const old = JSON.parse(readFileSync(join(dir, f), "utf8")) as { title?: string; intent?: string };
			const score = jaccard(mine, tokenSet(`${old.title ?? ""} ${old.intent ?? ""}`));
			if (score >= 0.5 && (!best || score > best.score)) best = { file: f, title: old.title ?? "?", score };
		} catch {
		}
	}
	return best;
};

export const hasOutcomeJargon = (text: string): string[] => {
	const hits: string[] = [];
	if (/```|`/.test(text)) hits.push("code fence/backtick");
	if (/\b[a-zA-Z0-9_-]+\.(ts|tsx|js|mjs|cjs|json|md|sh|yaml|yml)\b/.test(text)) hits.push("file name");
	if (/\.\.?\/|(^|\s)\//.test(text)) hits.push("path");
	if (/&&|\|\||\bnpm\s|\bnpx\s|\bnode\s|\bgit\s|\bgrep\s|\btsc\b|path exists:/.test(text)) hits.push("shell command");
	return hits;
};

export const applyQualityGate = (cwd: string, draft: SpecDraft): { draft: SpecDraft; notes: string[] } => {
	const notes: string[] = [];
	const extraDebt: string[] = [];
	const cases = draft.crossCheck?.length ? draft.crossCheck : undefined;
	if (!cases) {
		const legacy = draft.outcomes?.trim();
		if (!legacy) {
			extraDebt.push("quality-gate: no cross-check cases — the sign dialog will show the intent text; ask the requirements agent for 2–6 short user-language goal cases (\"you want … when …\")");
			notes.push("cross-check-missing");
		} else {
			const jargon = hasOutcomeJargon(legacy);
			if (jargon.length) {
				extraDebt.push(`quality-gate: legacy outcomes summary contains technical tokens (${jargon.join(", ")}) — rewrite it as short plain-language cases before signing`);
				notes.push("outcomes-jargon");
			}
		}
	} else {
		const long = cases.filter((c) => c.length > 240);
		if (long.length) {
			extraDebt.push("quality-gate: cross-check case(s) longer than 240 characters — split them into one short line per behavior so the signer can scan them");
			notes.push("cross-check-long");
		}
		const jargon = [...new Set(cases.flatMap((c) => hasOutcomeJargon(c)))];
		if (jargon.length) {
			extraDebt.push(`quality-gate: cross-check cases contain technical tokens (${jargon.join(", ")}) — rewrite them in plain language before signing`);
			notes.push("cross-check-jargon");
		}
	}
	if (!draft.scope.length) {
		extraDebt.push("quality-gate: scope not specified — every write would pass the scope check; name the path prefixes the agent may touch");
		notes.push("empty-scope");
	}
	for (const s of draft.scope) {
		const prefix = s.replace(/\*+$/, "").replace(/\/+$/, "");
		if (prefix && !existsSync(join(cwd, prefix))) {
			extraDebt.push(`quality-gate: scope \"${s}\" matches no real path in the repo — check the spelling/structure before signing`);
			notes.push(`scope-missing:${s.slice(0, 30)}`);
		}
	}
	for (const c of draft.criteria) {
		const ph = hasUnsubstitutedPlaceholder(c.check);
		if (ph) {
			extraDebt.push(`quality-gate: ${c.id} has an unsubstituted placeholder in its check ("${ph}") — fix the check before signing`);
			notes.push(`placeholder:${c.id}`);
		} else if (!isMachineCheckable(c.check)) {
			extraDebt.push(`quality-gate: ${c.id} has a check that can't be verified automatically ("${c.check.slice(0, 80)}") — requires human verification`);
			notes.push(`manual-check:${c.id}`);
		}
	}
	const similar = findSimilarSpec(cwd, draft);
	if (similar) {
		extraDebt.push(`quality-gate: intent looks similar to old spec "${similar.title}" (${similar.file}, similarity=${similar.score.toFixed(2)}) — confirm it isn't redundant before signing`);
		notes.push(`similar:${similar.file}`);
	}
	return { draft: { ...draft, specDebt: [...draft.specDebt, ...extraDebt] }, notes };
};
