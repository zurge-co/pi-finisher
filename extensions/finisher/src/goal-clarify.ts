import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { cleanChromeText } from "./chrome-text.ts";
import { DRAFT_CASES_MAX } from "./intake.ts";

export type ClarifyGap = "meaning" | "words" | "outcome";

export const CLARIFY_GAPS: readonly ClarifyGap[] = ["meaning", "words", "outcome"];

export const CLARIFY_MAX = 3;

export const CLARIFY_OPTIONS_MAX = CLARIFY_MAX + 1;

export interface ClarifyDraft {
	goal: string;
	cases: readonly string[];
}

export interface ClarifyQuestion {
	gap: ClarifyGap;
	question: string;
	options: string[];
}

export interface ClarifyChrome {
	title: string;
	asIs: string;
	later: string;
	note: string;
}

export interface ClarifyAnswerState {
	clarify?: { goalKey?: string; at?: number };
}

export interface ClarifyApplied {
	goal: string;
	goalText: string;
	cases: string[];
	notes: string[];
	open: ClarifyGap[];
}

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

export type ClarifyChromeOverrides = Partial<Record<keyof ClarifyChrome, string>>;

export const CLARIFY_CHROME_KEYS: readonly (keyof ClarifyChrome)[] = ["title", "asIs", "later", "note"];

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const EN_CHROME: ClarifyChrome = {
	title: "confirm that I read the goal the way you meant it",
	asIs: "as I said is enough",
	later: "let the rest be decided while working",
	note: "asked once, at most 3 questions, each one only to check that I understood the goal the way you meant it — never about how the work is done and never about how far it reaches",
};

const TH_CHROME: ClarifyChrome = {
	title: "ยืนยันว่าฉันเข้าใจ goal ตรงกับที่คุณหมายไว้",
	asIs: "ตามที่ฉันพูดก็พอ",
	later: "ที่เหลือให้ตัดสินระหว่างทำงาน",
	note: "ถามครั้งเดียว ไม่เกิน 3 ข้อ แต่ละข้อถามเพื่อยืนยันว่าฉันเข้าใจ goal ตรงกับคุณเท่านั้น — ไม่ถามว่าทำอย่างไร และไม่ถามขอบเขต",
};

export const CLARIFY_AS_IS: string = EN_CHROME.asIs;

export const CLARIFY_RULE: string = TH_CHROME.note;

export const clarifyChrome = (lang?: string, overrides?: ClarifyChromeOverrides): ClarifyChrome => ({
	...(thaiLang(lang) ? TH_CHROME : EN_CHROME),
	...cleanChromeText(CLARIFY_CHROME_KEYS, overrides),
});

const AS_IS_TEXTS = new Set([EN_CHROME.asIs, TH_CHROME.asIs, "as-is", "as is"].map((text) => text.toLowerCase()));

const PATH_RE = /(?:^|[\s`"'([{=:,])((?:[\w@.~-]+\/)*[\w@~-][\w@.~-]*\.[a-z][a-z0-9]{1,7})(?=$|[\s`"'),\]:;.!?])/i;

const BACKTICK_RE = /`[^`\n]+`/;

const DIGIT_RE = /\d/;

const BOUND_RE =
	/[<>≤≥]|ไม่เกิน|อย่างน้อย|ไม่ต่ำกว่า|ไม่มากกว่า|\b(?:at\s+most|at\s+least|no\s+more\s+than|no\s+less\s+than|fewer\s+than|less\s+than|greater\s+than|more\s+than|under|over|exactly)\b/i;

const COMMANDS = new Set([
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"node",
	"deno",
	"tsx",
	"git",
	"tsc",
	"make",
	"cargo",
	"go",
	"python",
	"python3",
	"pytest",
	"vitest",
	"jest",
	"mvn",
	"gradle",
	"rustc",
	"bash",
	"sh",
]);

const SUBCOMMANDS = new Set([
	"test",
	"tests",
	"run",
	"build",
	"install",
	"ci",
	"check",
	"lint",
	"add",
	"commit",
	"status",
	"diff",
	"exec",
	"typecheck",
	"verify",
	"release",
	"start",
	"fmt",
	"clippy",
	"bench",
	"log",
]);

const tokensOf = (text: string): string[] => text.split(/[\s,;:()"'`]+/).filter(Boolean);

const namesCommand = (tokens: string[], index: number): boolean => {
	const raw = (tokens[index] ?? "").replace(/^[>$]+/, "");
	const base = (raw.split("/").pop() ?? raw).toLowerCase();
	if (!COMMANDS.has(base)) return false;
	const next = (tokens[index + 1] ?? "").toLowerCase();
	if (!next) return true;
	if (next.startsWith("-") || next.startsWith("./") || next.startsWith("/") || next.startsWith("~/")) return true;
	if (SUBCOMMANDS.has(next)) return true;
	if (next.includes("/") || /\.[a-z][a-z0-9]{1,7}$/.test(next)) return true;
	return false;
};

export const decidable = (c: string): boolean => {
	const text = typeof c === "string" ? c : "";
	if (!collapse(text)) return false;
	if (BACKTICK_RE.test(text)) return true;
	if (PATH_RE.test(text)) return true;
	const tokens = tokensOf(text);
	if (tokens.some((_, index) => namesCommand(tokens, index))) return true;
	if (DIGIT_RE.test(text) || BOUND_RE.test(text)) return true;
	return false;
};

const VAGUE_WORDS = new Set([
	"a",
	"an",
	"again",
	"anything",
	"be",
	"best",
	"better",
	"bit",
	"clean",
	"cleaner",
	"code",
	"do",
	"does",
	"everything",
	"faster",
	"fix",
	"good",
	"great",
	"improve",
	"improved",
	"improvement",
	"it",
	"less",
	"little",
	"maintainable",
	"make",
	"modernise",
	"modernize",
	"more",
	"nice",
	"nicer",
	"optimise",
	"optimize",
	"please",
	"polish",
	"quick",
	"quicker",
	"readable",
	"refactor",
	"rework",
	"rewrite",
	"robust",
	"safer",
	"should",
	"simplify",
	"some",
	"something",
	"speed",
	"stable",
	"stuff",
	"that",
	"the",
	"them",
	"these",
	"things",
	"thing",
	"this",
	"those",
	"tidy",
	"to",
	"up",
	"update",
	"whole",
	"work",
]);

const THAI_VAGUE = [
	"อ่านง่ายขึ้น",
	"จัดระเบียบ",
	"ปรับปรุง",
	"อัพเกรด",
	"อัปเกรด",
	"เร็วขึ้น",
	"ดีขึ้น",
	"สวยขึ้น",
	"คล่องขึ้น",
	"เบาขึ้น",
	"ง่ายขึ้น",
	"กระชับ",
	"แก้ไข",
	"พัฒนา",
	"ทำให้",
	"ปรับ",
	"จัด",
	"แก้",
	"หน่อย",
	"มัน",
	"นี้",
	"ให้",
	"เร็ว",
	"ดี",
	"สวย",
	"ง่าย",
];

const AMBIGUOUS_LATIN = [
	"faster",
	"quicker",
	"slower",
	"better",
	"nicer",
	"cleaner",
	"simpler",
	"easier",
	"readable",
	"maintainable",
	"robust",
	"stable",
	"lighter",
	"smaller",
	"smoother",
	"modernise",
	"modernize",
	"optimise",
	"optimize",
];

const AMBIGUOUS_THAI = ["เร็วขึ้น", "ดีขึ้น", "สวยขึ้น", "ง่ายขึ้น", "อ่านง่ายขึ้น", "เบาขึ้น", "เสถียรขึ้น", "กระชับขึ้น", "คล่องขึ้น"];

const THAI_RE = /[\u0E00-\u0E7F]/;

const wordsOf = (text: string): string[] => collapse(text).toLowerCase().match(/[\p{L}\p{N}_%.@/~-]+/gu) ?? [];

const thaiVagueOnly = (goal: string): boolean => {
	let rest = goal;
	for (const term of THAI_VAGUE) rest = rest.split(term).join(" ");
	if (THAI_RE.test(rest)) return false;
	const latin = rest.match(/[a-z]{2,}/gi) ?? [];
	return latin.every((word) => VAGUE_WORDS.has(word.toLowerCase()));
};

const vagueTarget = (goal: string): boolean => {
	const text = collapse(goal);
	if (!text) return true;
	if (decidable(text)) return false;
	const words = wordsOf(text);
	if (words.length < 3) return true;
	if (words.every((word) => VAGUE_WORDS.has(word))) return true;
	return THAI_RE.test(text) ? thaiVagueOnly(text) : false;
};

const quantified = (goal: string): boolean => DIGIT_RE.test(goal) || BOUND_RE.test(goal);

export const ambiguousWord = (goal: string): string | undefined => {
	const text = collapse(goal);
	if (!text || quantified(text)) return undefined;
	for (const term of AMBIGUOUS_THAI) if (text.includes(term)) return term;
	const lower = text.toLowerCase();
	for (const term of AMBIGUOUS_LATIN) {
		const pattern = new RegExp(`(?<![a-z])${term}(?![a-z])`);
		if (pattern.test(lower)) return term;
	}
	return undefined;
};

const draftOf = (draft: ClarifyDraft | undefined): { goal: string; cases: string[] } => {
	const goal = typeof draft?.goal === "string" ? draft.goal : "";
	const raw: readonly string[] | undefined = draft?.cases;
	const cases = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
	return { goal, cases };
};

export const clarifyGaps = (draft: ClarifyDraft): ClarifyGap[] => {
	const { goal, cases } = draftOf(draft);
	const gaps: ClarifyGap[] = [];
	const stated = cases.some((c) => decidable(c));
	if (vagueTarget(goal)) gaps.push("meaning");
	if (ambiguousWord(goal)) gaps.push("words");
	if (!stated) gaps.push("outcome");
	return gaps.slice(0, CLARIFY_MAX);
};

const orderedGaps = (gaps: readonly ClarifyGap[] | undefined): ClarifyGap[] => {
	const wanted = new Set(gaps ?? []);
	return CLARIFY_GAPS.filter((gap) => wanted.has(gap)).slice(0, CLARIFY_MAX);
};

const uniqueOptions = (options: readonly string[], asIs: string): string[] => {
	const seen = new Set<string>([asIs.toLowerCase()]);
	const out: string[] = [];
	for (const raw of options) {
		const text = collapse(raw);
		const key = text.toLowerCase();
		if (!text || seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
};

const EN_MEANING = [
	"exactly the words you used, nothing added",
	"the same thing, but it has to be noticeable when you use it",
	"the same thing, and what already works has to keep working",
];

const TH_MEANING = ["ตรงตามที่คุณพูดไว้ทุกคำ ไม่เพิ่มไม่ลด", "เรื่องเดียวกัน แต่ต้องรู้สึกได้ตอนคุณใช้", "เรื่องเดียวกัน และของที่ใช้ได้อยู่ต้องใช้ได้ต่อไป"];

const EN_WORD_TAIL = ["in a way you notice while using it", "in a way you can point at as a number", "without changing what already works"];

const TH_WORD_TAIL = ["แบบรู้สึกได้ตอนใช้", "แบบชี้เป็นตัวเลขได้", "โดยของเดิมไม่ต้องเปลี่ยน"];

const EN_OUTCOME = [
	"I run `npm test` and it is all green",
	"the thing that bothers me stops happening when I use it",
	"it works the way the goal says and nothing that works today breaks",
];

const TH_OUTCOME = ["ฉันรัน `npm test` แล้วเขียวหมด", "เรื่องที่กวนใจฉันอยู่ไม่เกิดอีกตอนใช้งาน", "ได้ตาม goal และของที่ใช้ได้วันนี้ยังใช้ได้"];

const QUESTION_TEXT: Record<ClarifyGap, { en: string; th: string }> = {
	meaning: {
		en: "so that I read the goal the way you meant it — which of these is what you mean? pick one:",
		th: "เพื่อให้ฉันเข้าใจ goal ตรงกับที่คุณหมายไว้ — ข้อไหนคือสิ่งที่คุณหมายถึง? เลือกหนึ่งข้อ:",
	},
	words: {
		en: 'I want to be sure I understand the word you used — what does it mean to you here? pick one:',
		th: "ฉันอยากเข้าใจคำที่คุณใช้ให้ตรง — คำนี้หมายถึงอะไรสำหรับคุณ? เลือกหนึ่งข้อ:",
	},
	outcome: {
		en: "and the result you expect to see at the end is — pick one:",
		th: "แล้วผลที่คุณคาดว่าจะเห็นตอนจบคือ — เลือกหนึ่งข้อ:",
	},
};

const optionsFor = (gap: ClarifyGap, draft: { goal: string }, lang?: string): string[] => {
	const thai = thaiLang(lang);
	if (gap === "meaning") return thai ? TH_MEANING : EN_MEANING;
	if (gap === "outcome") return thai ? TH_OUTCOME : EN_OUTCOME;
	const word = ambiguousWord(draft.goal) ?? draft.goal;
	return (thai ? TH_WORD_TAIL : EN_WORD_TAIL).map((tail) => `${word} ${tail}`);
};

export const clarifyQuestions = (gaps: readonly ClarifyGap[], draft: ClarifyDraft, lang?: string, chrome?: ClarifyChromeOverrides): ClarifyQuestion[] => {
	const words = clarifyChrome(lang, chrome);
	const parsed = draftOf(draft);
	const thai = thaiLang(lang);
	return orderedGaps(gaps).map((gap) => ({
		gap,
		question: QUESTION_TEXT[gap][thai ? "th" : "en"],
		options: [...uniqueOptions(optionsFor(gap, parsed, lang), words.asIs).slice(0, CLARIFY_OPTIONS_MAX - 1), words.asIs],
	}));
};

const usableAnswer = (value: unknown, asIs?: string): string | undefined => {
	if (typeof value !== "string") return undefined;
	const text = collapse(value);
	if (!text || AS_IS_TEXTS.has(text.toLowerCase())) return undefined;
	if (asIs && text.toLowerCase() === asIs.trim().toLowerCase()) return undefined;
	return text;
};

const CLAUSE_LABEL: Record<ClarifyGap, { en: string; th: string }> = {
	meaning: { en: "what I understand you to mean", th: "ความหมายที่ฉันเข้าใจ" },
	words: { en: "the word you used", th: "คำที่คุณใช้" },
	outcome: { en: "the result you expect", th: "ผลที่คุณคาด" },
};

export const applyAnswers = (draft: ClarifyDraft, answers: Partial<Record<ClarifyGap, string>>, lang?: string, chrome?: ClarifyChromeOverrides): ClarifyApplied => {
	const base = draftOf(draft);
	const asIs = clarifyChrome(lang, chrome).asIs;
	const cases = [...base.cases];
	const notes: string[] = [];
	const answered = new Set<ClarifyGap>();
	for (const gap of CLARIFY_GAPS) {
		const answer = usableAnswer(answers?.[gap], asIs);
		if (!answer) continue;
		answered.add(gap);
		if (cases.some((c) => collapse(c).toLowerCase() === answer.toLowerCase())) continue;
		if (decidable(answer) && cases.length < DRAFT_CASES_MAX) {
			cases.push(answer);
			continue;
		}
		notes.push(`${CLAUSE_LABEL[gap][thaiLang(lang) ? "th" : "en"]}: ${answer}`);
	}
	const goalText = notes.length ? [base.goal, ...notes].filter(Boolean).join(" — ") : base.goal;
	const filled = cases.length ? cases : [base.goal || goalText];
	return { goal: base.goal, goalText, cases: filled, notes, open: CLARIFY_GAPS.filter((gap) => !answered.has(gap)) };
};

export const clarifyOpen = (state: ClarifyAnswerState | undefined, goalKey: string): boolean => state?.clarify?.goalKey !== goalKey;

export const markClarify = (state: ClarifyAnswerState, goalKey: string, at = Date.now()): void => {
	state.clarify = { goalKey, at };
};

export interface ClarifyPlan {
	ask: boolean;
	gaps: ClarifyGap[];
	questions: ClarifyQuestion[];
}

export const clarifyPlan = (draft: ClarifyDraft, state: ClarifyAnswerState | undefined, goalKey: string, lang?: string, chrome?: ClarifyChromeOverrides): ClarifyPlan => {
	const gaps = clarifyGaps(draft);
	const ask = gaps.length > 0 && clarifyOpen(state, goalKey);
	return { ask, gaps, questions: ask ? clarifyQuestions(gaps, draft, lang, chrome) : [] };
};

export const clarifyNote = (open: readonly ClarifyGap[], lang?: string, chrome?: ClarifyChromeOverrides): string => {
	const gaps = orderedGaps(open);
	const words = clarifyChrome(lang, chrome);
	if (!gaps.length)
		return thaiLang(lang) ? "ไม่ต้องถามเพิ่ม: ฉันเข้าใจ goal นี้ตรงกับที่คุณหมายไว้แล้ว" : "nothing to ask: I already read this goal the way you meant it";
	return thaiLang(lang) ? `ยังมี ${gaps.length} จุดที่ฉันยังไม่แน่ใจว่าเข้าใจตรงกัน — ${words.note}` : `${gaps.length} point(s) I still want to confirm about what you mean — ${words.note}`;
};
