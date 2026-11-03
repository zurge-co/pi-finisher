import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { cleanChromeText, usableChrome } from "./chrome-text.ts";
import { DRAFT_CASES_MAX } from "./intake.ts";

export type ClarifyGap = "meaning" | "words" | "outcome";

export const CLARIFY_GAPS: readonly ClarifyGap[] = ["meaning", "words", "outcome"];

export const CLARIFY_MAX = 3;

export const CLARIFY_OPTIONS_MAX = 5;

export interface ClarifyQuestion {
	gap?: ClarifyGap;
	question: string;
	options: string[];
}

export interface ClarifyChrome {
	title: string;
	asIs: string;
	later: string;
	note: string;
}

export type ClarifyChromeOverrides = Partial<Record<keyof ClarifyChrome, string>>;

export const CLARIFY_CHROME_KEYS: readonly (keyof ClarifyChrome)[] = ["title", "asIs", "later", "note"];

export interface ClarifyDraft {
	goal: string;
	cases: readonly string[];
}

export interface ClarifyAnswerState {
	clarify?: { goalKey?: string; at?: number };
}

export interface ClarifyAnswered {
	question: string;
	answer: string;
}

export interface ClarifyApplied {
	goal: string;
	goalText: string;
	cases: string[];
	notes: string[];
	open: string[];
}

export interface ClarifyPlan {
	ask: boolean;
	questions: ClarifyQuestion[];
}

export const CLARIFY_ASK_RULE =
	"a question exists only when a word the human used can go more than one way and you really need to know which one they meant: every question and every choice is yours, written from your own reading of their words — this parameter never has a canned list behind it. Ask nothing when one reading is the only reading: no question, no choices, no clarify note, and goal goes straight to the confirm dialog.";

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

const EN_CHROME: ClarifyChrome = {
	title: "one word of yours can go two ways",
	asIs: "as I said is enough",
	later: "decide the rest while working",
	note: "asked once, at most 3 questions, each one only about what you meant — never about how the work is done and never about how far it reaches",
};

const TH_CHROME: ClarifyChrome = {
	title: "คำที่คุณใช้ตีความได้มากกว่าหนึ่งทาง",
	asIs: "ตามที่ฉันพูดก็พอ",
	later: "ที่เหลือให้ตัดสินระหว่างทำงาน",
	note: "ถามครั้งเดียว ไม่เกิน 3 ข้อ แต่ละข้อถามถึงสิ่งที่คุณหมายเท่านั้น — ไม่ถามว่าทำอย่างไร และไม่ถามขอบเขต",
};

export const CLARIFY_AS_IS: string = EN_CHROME.asIs;

export const CLARIFY_RULE: string = TH_CHROME.note;

export const clarifyChrome = (lang?: string, overrides?: ClarifyChromeOverrides): ClarifyChrome => ({
	...(thaiLang(lang) ? TH_CHROME : EN_CHROME),
	...cleanChromeText(CLARIFY_CHROME_KEYS, overrides),
});

const gapOf = (value: unknown): ClarifyGap | undefined => {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return CLARIFY_GAPS.find((gap) => gap === text);
};

const oneLine = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

export const clarifyOptions = (raw: unknown): string[] => {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of raw) {
		const text = oneLine(value);
		if (!usableChrome(text)) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
		if (out.length >= CLARIFY_OPTIONS_MAX) break;
	}
	return out;
};

export const readClarifyQuestions = (raw: unknown): ClarifyQuestion[] => {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: ClarifyQuestion[] = [];
	for (const item of raw) {
		const question = oneLine((item as { question?: unknown } | undefined)?.question);
		if (!usableChrome(question)) continue;
		const options = clarifyOptions((item as { options?: unknown } | undefined)?.options);
		if (options.length < 2) continue;
		const key = question.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const gap = gapOf((item as { gap?: unknown } | undefined)?.gap);
		out.push({ question, options, ...(gap ? { gap } : {}) });
		if (out.length >= CLARIFY_MAX) break;
	}
	return out;
};

const PATH_RE = /(?:^|[\s`"'([{=:,])((?:[\w@.~-]+\/)*[\w@~-][\w@.~-]*\.[a-z][a-z0-9]{1,7})(?=$|[\s`"'),\]:;.!?])/i;

const NAMED_COMMAND = /(?:^|[\s`"'([{=:,])(?:npm|npx|pnpm|yarn|bun|node|deno|tsx|git|tsc|make|cargo|go|python3?|pytest|vitest|jest|mvn|gradle|bash|sh)\b/;

const NUMBER_OR_BOUND = /\d|[<>≤≥]/;

export const checkableAnswer = (answer: string): boolean => PATH_RE.test(answer) || NAMED_COMMAND.test(answer) || /`[^`\n]+`/.test(answer) || NUMBER_OR_BOUND.test(answer);

export const clarifyOpen = (state: ClarifyAnswerState | undefined, goalKey: string): boolean => state?.clarify?.goalKey !== goalKey;

export const markClarify = (state: ClarifyAnswerState, goalKey: string, at = Date.now()): void => {
	state.clarify = { goalKey, at };
};

export const clarifyPlan = (questions: readonly ClarifyQuestion[], state: ClarifyAnswerState | undefined, goalKey: string): ClarifyPlan => {
	const list = Array.isArray(questions) ? questions.slice(0, CLARIFY_MAX) : [];
	const ask = list.length > 0 && clarifyOpen(state, goalKey);
	return { ask, questions: ask ? list : [] };
};

const noAnswer = (text: string, words: ClarifyChrome): boolean => {
	const key = text.trim().toLowerCase();
	return [CLARIFY_AS_IS, "as-is", "as is", words.asIs].some((escape) => key === escape.trim().toLowerCase());
};

const answerOf = (answers: readonly ClarifyAnswered[], question: string): string | undefined => {
	const key = question.trim().toLowerCase();
	for (const entry of answers ?? []) {
		if (oneLine(entry?.question).toLowerCase() !== key) continue;
		return oneLine(entry?.answer) || undefined;
	}
	return undefined;
};

export const applyAnswers = (draft: ClarifyDraft, questions: readonly ClarifyQuestion[], answers: readonly ClarifyAnswered[], lang?: string, chrome?: ClarifyChromeOverrides): ClarifyApplied => {
	const words = clarifyChrome(lang, chrome);
	const goal = typeof draft?.goal === "string" ? draft.goal : "";
	const rawCases = draft?.cases;
	const cases = Array.isArray(rawCases) ? rawCases.filter((c): c is string => typeof c === "string") : [];
	const notes: string[] = [];
	const open: string[] = [];
	const picked = [...cases];
	for (const question of Array.isArray(questions) ? questions : []) {
		const answer = answerOf(answers, question.question);
		if (!answer || noAnswer(answer, words)) {
			open.push(question.question);
			continue;
		}
		const known = picked.some((c) => c.trim().toLowerCase() === answer.toLowerCase());
		if (!known && checkableAnswer(answer) && picked.length < DRAFT_CASES_MAX) {
			picked.push(answer);
			continue;
		}
		if (!known) notes.push(`${question.question} → ${answer}`);
	}
	const goalText = notes.length ? [goal, ...notes].filter(Boolean).join(" — ") : goal;
	return { goal, goalText, cases: picked, notes, open };
};

export const clarifyNote = (open: readonly string[], lang?: string, chrome?: ClarifyChromeOverrides): string => {
	const still = Array.isArray(open) ? open.filter((text) => typeof text === "string" && text.trim()) : [];
	const words = clarifyChrome(lang, chrome);
	if (!still.length)
		return thaiLang(lang) ? "ไม่ต้องถามเพิ่ม: ฉันเข้าใจ goal นี้ตรงกับที่คุณหมายไว้แล้ว" : "nothing to ask: I already read this goal the way you meant it";
	return thaiLang(lang) ? `ยังมี ${still.length} จุดที่ฉันยังไม่แน่ใจว่าเข้าใจตรงกัน — ${words.note}` : `${still.length} point(s) I still want to confirm about what you mean — ${words.note}`;
};
