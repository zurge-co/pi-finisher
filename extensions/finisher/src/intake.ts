import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";

export const INTAKE_GRACE_CALLS = 2;

export const INTAKE_EXPLORE_TOOLS: readonly string[] = ["read", "bash", "grep", "find", "ls", "glob", "edit", "write"];

export const isExploreTool = (toolName: string): boolean => INTAKE_EXPLORE_TOOLS.includes(String(toolName ?? "").trim().toLowerCase());

export interface IntakeGoal {
	goal?: string;
	confirmedAt?: number;
}

export const intakeOpen = (goal: IntakeGoal | undefined): boolean => (Number.isFinite(goal?.confirmedAt) ? (goal?.confirmedAt ?? 0) > 0 : false);

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

export interface IntakeRefusal {
	block: boolean;
	reason?: string;
	remaining: number;
}

const callCount = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

export const intakeGate = (goal: IntakeGoal | undefined, toolName: string, preGoalCalls: number, lang?: string): IntakeRefusal => {
	const used = callCount(preGoalCalls);
	const remaining = Math.max(0, INTAKE_GRACE_CALLS - used);
	if (intakeOpen(goal) || !isExploreTool(toolName) || used < INTAKE_GRACE_CALLS) return { block: false, remaining };
	return { block: true, remaining: 0, reason: intakeBlockNote(lang, 0) };
};

export const intakeBlockNote = (lang: string | undefined, remaining: number): string => {
	const left = callCount(remaining);
	return thaiLang(lang)
		? `ยังไม่มีการยืนยัน goal: การสำรวจโค้ดถูกปิดแล้ว (เหลือ ${left} ครั้ง) — goal และ case ฉบับร่างเตรียมไว้จากข้อความของมนุษย์แล้ว ให้เรียก goal ก่อน แล้วค่อยสำรวจโค้ด`
		: `no goal is confirmed yet: code exploration is closed (${left} call(s) left) — the draft goal and its cases are already prepared from the human's message, so call goal first and explore only after that`;
};

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

export const intakeDirective = (prompt: string, lang?: string): string => {
	const draft = intakeDraft(prompt);
	const numbered = draft.cases.map((c, i) => `${i + 1}. ${c}`).join("  ");
	if (!draft.goal)
		return thaiLang(lang)
			? "ยังไม่มี goal: ถามมนุษย์ว่า goal คืออะไรด้วยคำพูดของเขาเอง แล้วเรียก goal ก่อนสำรวจโค้ดใด ๆ"
			: "no goal yet: ask the human for the goal in their own words, then call goal before any code exploration";
	if (thaiLang(lang))
		return `goal ยังไม่ถูกยืนยัน — ฉบับร่างจากข้อความของมนุษย์: goal = ${draft.goal} | case = ${numbered}. เรียก goal ด้วย goal และ case ชุดนี้ก่อนอ่าน/grep/bash ใด ๆ (สำรวจโค้ดได้อีก ${INTAKE_GRACE_CALLS} ครั้งก่อนถูกปิด) มนุษย์ยืนยันครั้งเดียว และ goal เดิมจะไม่ถูกถามซ้ำ`;
	return `no goal is confirmed yet — the draft from the human's own message: goal = ${draft.goal} | cases = ${numbered}. Call goal with this goal and these cases before any read/grep/bash (exploration is closed after ${INTAKE_GRACE_CALLS} calls); the human confirms once and the same goal is never asked again`;
};
