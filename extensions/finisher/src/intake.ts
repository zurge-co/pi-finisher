import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { consultDirective, decideDirective, type TurnIntent } from "./consult.ts";

export interface IntakeGoal {
	goal?: string;
	confirmedAt?: number;
}

export const intakeOpen = (goal: IntakeGoal | undefined): boolean => (Number.isFinite(goal?.confirmedAt) ? (goal?.confirmedAt ?? 0) > 0 : false);

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

export const DRAFT_GOAL_MAX = 200;
export const DRAFT_CASES_MAX = 5;

const LIST_MARK = /^(?:[-*•>]\s+|\d+[.)]\s+)/;
const QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const clean = (line: string): string => collapse(line.replace(LIST_MARK, "").replace(QUOTES, ""));

const cut = (text: string, max: number): string => {
	if (text.length <= max) return text;
	const window = text.slice(Math.max(0, max - 20), max);
	const at = window.lastIndexOf(" ");
	const end = at <= 0 ? max : Math.max(1, max - 20 + at);
	return text.slice(0, end).trim();
};

const promptLines = (prompt: string): string[] => {
	const text = typeof prompt === "string" ? prompt : "";
	return text.split(/\r?\n/).map(clean).filter((line) => line.length > 0);
};

export const draftGoal = (prompt: string): string => cut(promptLines(prompt)[0] ?? "", DRAFT_GOAL_MAX);

export const draftCases = (prompt: string, goal?: string): string[] => {
	const all = promptLines(prompt);
	if (!all.length) return [];
	const head = goal === undefined || !clean(goal) ? all[0] : clean(goal);
	const headKey = head.toLowerCase();
	const taken = new Set<string>([headKey]);
	const out: string[] = [];
	for (const line of all) {
		for (const part of line.split(/(?<=[.;!?])\s+/)) {
			if (out.length >= DRAFT_CASES_MAX) break;
			const candidate = clean(part);
			const key = candidate.toLowerCase();
			if (!candidate || taken.has(key)) continue;
			taken.add(key);
			out.push(candidate);
		}
	}
	return out.length ? out : [head];
};

export interface IntakeDraft {
	goal: string;
	cases: string[];
}

export const intakeDraft = (prompt: string): IntakeDraft => {
	const goal = draftGoal(prompt);
	return { goal, cases: draftCases(prompt, goal) };
};

export const draftDirective = (prompt: string, lang?: string): string => {
	const draft = intakeDraft(prompt);
	const numbered = draft.cases.map((c, i) => `${i + 1}. ${c}`).join("  ");
	if (!draft.goal)
		return thaiLang(lang)
			? "ยังไม่มี goal: ถามมนุษย์ว่า goal คืออะไรด้วยคำพูดของเขาเอง แล้วเรียก goal ก่อนลงมือ"
			: "no goal yet: ask the human for the goal in their own words, then call goal before you start";
	if (thaiLang(lang))
		return `ถ้าข้อความนี้เป็นงานที่ต้องลงมือ — ฉบับร่างจากคำพูดของมนุษย์: goal = ${draft.goal} | case = ${numbered}. เรียก goal ด้วย goal และ case ชุดนี้ ไม่ต้องเดา มนุษย์ยืนยันครั้งเดียว และ goal เดิมจะไม่ถูกถามซ้ำ`;
	return `if this message is a work order — the draft from the human's own words: goal = ${draft.goal} | cases = ${numbered}. Call goal with this goal and these cases instead of guessing; the human confirms once and the same goal is never asked again`;
};

export const intakeDirective = (prompt: string, lang?: string, intent?: TurnIntent): string => {
	if (intent === "consult") return consultDirective(prompt, lang);
	if (intent === "decide") return decideDirective(prompt, lang);
	return draftDirective(prompt, lang);
};
