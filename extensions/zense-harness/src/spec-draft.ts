// zense-harness module: requirements draft parsing: clarify/spec JSON parse, machine-checkable heuristic, quality gate + duplicate-spec guard (moved verbatim from index.ts — see AGENTS.md map)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Criterion } from "./types.ts";
import { hasUnsubstitutedPlaceholder } from "./evidence.ts";

// ----------------------------------------------------------------------------- requirements draft parsing (module scope — exported for unit tests)

export interface SpecDraft {
	title: string;
	intent: string;
	/** Plain-language "what you'll get" for the human signer (request-language, no jargon/
	 *  file paths/shell commands) — the ONLY thing the sign dialog shows. Optional at parse time
	 *  (an absent summary is a quality-gate note, not a parse error — the dialog falls back to
	 *  intent) so older sub-agent outputs and explicit agent-authored drafts keep working. */
	outcomes?: string;
	approach: string[];
	scope: string[];
	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];
}

/** One clarify question (normalized) — a question TO THE HUMAN, so it must satisfy
 *  QUESTION_POLICY below: either answer options the human picks from ("Other (type your own)"
 *  is appended by the picker), or freeText:true for a product/UI-outcome question that
 *  genuinely has no guessable options (renders a plain input). A legacy bare string carries
 *  neither and is REJECTED (2026-10-16) — never silently downgraded to an open question. */
export interface ClarifyQuestion {
	question: string;
	choices: string[];
	freeText?: boolean;
}

/** Question policy (2026-10-16) — the ONE contract shared by the requirements clarify loop,
 *  the planner prompts and the zense_ask tool. A question to the human is a PRODUCT/UI-OUTCOME
 *  question ("what should the result be/do?"), never an internal technical/detail decision
 *  (library, module split, naming, test approach, data shape, refactor structure): the agent
 *  decides those itself from the repo/context, proceeds, and records the decision as an
 *  explicit assumption + specDebt entry the human sees at signing. Answer options are the
 *  default; omitting them is legal ONLY with an explicit "freeText": true marker for a
 *  genuine product/UI question that has no guessable options. */
export const QUESTION_POLICY =
	"Ask ONLY product/UI-outcome questions — what the human wants the result to be or do — each with 2–6 pickable choices. " +
	'Never ask internal technical/detail questions (library, module split, naming, test approach, data shape, refactor structure): decide those from the repo/context, proceed, and record the decision as an explicit assumption plus a specDebt entry. ' +
	'Choices may be omitted only for a product/UI question with genuinely no guessable options, and then the question MUST set "freeText": true.';

/** Picker cap: >6 options is a menu, not a decision check-in. */
export const MAX_CLARIFY_CHOICES = 6;

/** One scan of raw clarify questions: the ACCEPTED ones plus one feedback line per rejected
 *  item (the requirements sub-agent gets the lines back as retry feedback, so a policy
 *  violation costs a round instead of silently reaching the human). */
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

/** Normalize + police raw clarify questions → ClarifyScan. Accepted shapes: {question,
 *  choices:[…]} (capped at MAX_CLARIFY_CHOICES) and {question, freeText:true} (product/UI
 *  question with no guessable options). Rejected with a feedback line: a bare string and any
 *  object with neither choices nor the freeText marker — the two ways a model used to hand the
 *  human an open-ended (often internal technical) question. Items with no question text are
 *  not questions at all and are skipped silently (unchanged behavior). */
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

/** Back-compat view of scanClarifyQuestions: the ACCEPTED questions only (undefined when none).
 *  Callers that must surface the policy feedback use scanClarifyQuestions. */
export const asClarifyQuestions = (v: unknown): ClarifyQuestion[] | undefined => {
	const { questions } = scanClarifyQuestions(v);
	return questions.length ? questions : undefined;
};

/** Retry feedback for rejected questions — names the policy AND the offenders so the retrying
 *  sub-agent (or the main agent) can fix exactly what broke instead of guessing. */
export const questionPolicyError = (violations: string[]): string =>
	`question policy violation — ${QUESTION_POLICY} Rejected: ${violations.join("; ")}`;

/**
 * Extract a single JSON object from sub-agent output — tolerant of raw JSON, ```json fences,
 * and surrounding prose (first-'{' to last-'}'), because models love adding prose despite
 * being told not to; a single strict parse would fail needlessly often.
 */
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
			/* try the next candidate */
		}
	}
	return undefined;
};

/**
 * A: parse + validate the requirements sub-agent draft per contract:
 *   - spec shape    → {title,intent,approach,scope,constraints,criteria[{id,text,check}],specDebt}
 *   - clarify shape (F) → {"questions": [...]} (ask back instead of guessing) — counts as
 *     clarify only when no criteria are present; each question is {question, choices} or
 *     {question, freeText:true} per QUESTION_POLICY — a bare string / a choice-less question is
 *     an ERROR (retry feedback), never a silent open question
 *   - anything else → error describing what broke (used as feedback on the round-2 retry)
 * Minor shape issues are normalized (missing criteria ids → auto c1..n, missing arrays → []),
 * but empty criteria / items without text+check are invalid — a spec without teeth is worse
 * than none.
 */
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
	return {
		kind: "spec",
		draft: {
			title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : "untitled",
			intent: typeof o.intent === "string" ? o.intent : "",
			outcomes: typeof o.outcomes === "string" && o.outcomes.trim() ? o.outcomes.trim() : undefined,
			approach: asStringArray(o.approach) ?? [],
			scope: asStringArray(o.scope) ?? [],
			constraints: asStringArray(o.constraints) ?? [],
			criteria,
			specDebt: asStringArray(o.specDebt) ?? [],
		},
	};
};

/**
 * Heuristic: can the harness/grader actually run this check automatically? Passes on known
 * command tokens, backtick-quoted commands, '$'-prompts, or a path-exists pattern; words like
 * "manual"/"by eye" fail immediately. The quality gate (G) pushes uncheckable criteria into
 * specDebt (forced human review). Intentionally permissive (false negatives beat false
 * positives: anything uncertain must land in specDebt).
 */
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

/** G: duplicate-spec guard — scan the newest 20 archive specs (.zense/specs/*.json) and
 *  compare title+intent tokens; Jaccard ≥ 0.5 counts as "similar" (loose enough to catch
 *  paraphrases without flagging genuinely different work). */
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
			/* skip corrupt archive files */
		}
	}
	return best;
};

/** Outcome-summary jargon heuristic (2026-10-16): the outcomes text is the ONLY thing the
 *  signer reads, so it must read like product language, not engineering notes. Conservative by
 *  design — only tokens that are unambiguous engineering artifacts flag it: code fences/
 *  backticks, file extensions/paths, shell-composition operators, command invocations,
 *  path-exists checks. False negatives are fine (a human still reads it at signing); false
 *  positives would push clean text into specDebt, so the token set stays narrow. */
export const hasOutcomeJargon = (text: string): string[] => {
	const hits: string[] = [];
	if (/```|`/.test(text)) hits.push("code fence/backtick");
	if (/\b[a-zA-Z0-9_-]+\.(ts|tsx|js|mjs|cjs|json|md|sh|yaml|yml)\b/.test(text)) hits.push("file name");
	if (/\.\.?\/|(^|\s)\//.test(text)) hits.push("path");
	if (/&&|\|\||\bnpm\s|\bnpx\s|\bnode\s|\bgit\s|\bgrep\s|\btsc\b|path exists:/.test(text)) hits.push("shell command");
	return hits;
};

/**
 * G: harness-side quality gate — the sub-agent is good at drafting, but the harness must be
 * skeptical on the human's behalf: empty scope / unverifiable check / duplicate of an old spec
 * → forced into specDebt (human review at eval/review). Returns a new draft (no mutation)
 * plus short notes about what was added (telemetry + tool-result messaging).
 */
export const applyQualityGate = (cwd: string, draft: SpecDraft): { draft: SpecDraft; notes: string[] } => {
	const notes: string[] = [];
	const extraDebt: string[] = [];
	// outcome-summary gates (2026-10-16): absent → the sign dialog falls back to the intent
	// text (still readable, but the signer deserves the dedicated summary); jargon → the signer
	// pain point this field exists to fix, so it goes to human review instead of silently
	// rendering command soup in the sign dialog
	if (!draft.outcomes) {
		extraDebt.push("quality-gate: no plain-language outcomes summary — the sign dialog will show the intent text instead; ask the requirements agent for one (request-language, no jargon)");
		notes.push("outcomes-missing");
	} else {
		const jargon = hasOutcomeJargon(draft.outcomes);
		if (jargon.length) {
			extraDebt.push(`quality-gate: outcomes summary contains technical tokens (${jargon.join(", ")}) — rewrite it in plain language before signing`);
			notes.push("outcomes-jargon");
		}
	}
	if (!draft.scope.length) {
		extraDebt.push("quality-gate: scope not specified — every write would pass the scope check; name the path prefixes the agent may touch");
		notes.push("empty-scope");
	}
	// W3: a scope typo = silently toothless gate — a prefix with no real path matches no writes
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
