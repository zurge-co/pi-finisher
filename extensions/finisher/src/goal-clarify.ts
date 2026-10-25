import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { DRAFT_CASES_MAX } from "./intake.ts";

export type ClarifyGap = "target" | "observable" | "scope";

export const CLARIFY_GAPS: readonly ClarifyGap[] = ["target", "observable", "scope"];

export const CLARIFY_MAX = 3;

export interface ClarifyDraft {
	goal: string;
	cases: readonly string[];
}

export interface ClarifyChoices {
	targets: readonly string[];
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

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const EN_CHROME: ClarifyChrome = {
	title: "clarify the goal before it is confirmed",
	asIs: "as I said is enough",
	later: "let the rest be decided while working",
	note: "asked once, at most 3 questions, each with options to pick, and never a question that reading the code would answer",
};

const TH_CHROME: ClarifyChrome = {
	title: "ทำเป้าหมายให้ชัดก่อนยืนยัน",
	asIs: "ตามที่ฉันพูดก็พอ",
	later: "ที่เหลือให้ตัดสินระหว่างทำงาน",
	note: "ถามครั้งเดียว ไม่เกิน 3 ข้อ มีตัวเลือกให้เลือก และไม่ถามสิ่งที่อ่านโค้ดตอบได้",
};

export const CLARIFY_AS_IS: string = EN_CHROME.asIs;

export const CLARIFY_RULE: string = TH_CHROME.note;

export const clarifyChrome = (lang?: string): ClarifyChrome => (thaiLang(lang) ? TH_CHROME : EN_CHROME);

const AS_IS_TEXTS = new Set([EN_CHROME.asIs, TH_CHROME.asIs, "as-is", "as is"].map((text) => text.toLowerCase()));

const PATH_RE = /(?:^|[\s`"'([{=:,])((?:[\w@.~-]+\/)*[\w@~-][\w@.~-]*\.[a-z][a-z0-9]{1,7})(?=$|[\s`"'),\]:;.!?])/i;

const BACKTICK_RE = /`[^`\n]+`/;

const DIGIT_RE = /\d/;

const BOUND_RE =
	/[<>≤≥]|ไม่เกิน|อย่างน้อย|ไม่ต่ำกว่า|ไม่มากกว่า|\b(?:at\s+most|at\s+least|no\s+more\s+than|no\s+less\s+than|fewer\s+than|less\s+than|greater\s+than|more\s+than|under|over|exactly)\b/i;

const EXIT_RE = /\bexits?\b|\bexit\s*(?:code|status)\b|\bคืนค่า\b/i;

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
	if (DIGIT_RE.test(text)) return true;
	if (BOUND_RE.test(text)) return true;
	return EXIT_RE.test(text);
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

const draftOf = (draft: ClarifyDraft | undefined): { goal: string; cases: string[] } => {
	const goal = typeof draft?.goal === "string" ? draft.goal : "";
	const raw: readonly string[] | undefined = draft?.cases;
	const cases = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
	return { goal, cases };
};

export const clarifyGaps = (draft: ClarifyDraft): ClarifyGap[] => {
	const { goal, cases } = draftOf(draft);
	const anchored = cases.some(decidable);
	const gaps: ClarifyGap[] = [];
	if (vagueTarget(goal)) gaps.push("target");
	if (!anchored) gaps.push("observable");
	if (!anchored && !decidable(goal)) gaps.push("scope");
	return gaps.slice(0, CLARIFY_MAX);
};

const orderedGaps = (gaps: readonly ClarifyGap[] | undefined): ClarifyGap[] => {
	const wanted = new Set(gaps ?? []);
	return CLARIFY_GAPS.filter((gap) => wanted.has(gap)).slice(0, CLARIFY_MAX);
};

const uniqueOptions = (options: readonly string[] | undefined, asIs: string): string[] => {
	const seen = new Set<string>([asIs.toLowerCase()]);
	const out: string[] = [];
	for (const raw of options ?? []) {
		const text = typeof raw === "string" ? collapse(raw) : "";
		const key = text.toLowerCase();
		if (!text || seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
};

const EN_TARGET_OPTIONS = ["the file that owns the behaviour", "the screen or command the human sees", "the whole module, not one line"];

const TH_TARGET_OPTIONS = ["ไฟล์ที่คุมพฤติกรรมนี้", "หน้าจอหรือคำสั่งที่มนุษย์เห็น", "ทั้งโมดูล ไม่ใช่บรรทัดเดียว"];

const EN_OBSERVE_OPTIONS = ["npm test exits 0", "npm run typecheck exits 0", "the failing case replays green"];

const TH_OBSERVE_OPTIONS = ["npm test ออกด้วย exit code 0", "npm run typecheck ผ่าน", "เคสที่พังอยู่เล่นซ้ำแล้วได้ exit code 0"];

const EN_SCOPE_OPTIONS = ["only the path the goal names", "every file the change touches, tests included"];

const TH_SCOPE_OPTIONS = ["เฉพาะ path ที่ goal ระบุ", "ทุกไฟล์ที่การเปลี่ยนนี้แตะ รวม test"];

const pathsOf = (text: string): string[] => {
	const re = new RegExp(PATH_RE.source, "gi");
	const found: string[] = [];
	for (const match of text.matchAll(re)) {
		const path = match[1] ?? "";
		if (path && !found.some((seen) => seen.toLowerCase() === path.toLowerCase())) found.push(path);
	}
	return found;
};

const scopeOptions = (draft: { goal: string; cases: string[] }, lang?: string): string[] => {
	const [anchor] = pathsOf([draft.goal, ...draft.cases].join(" "));
	if (!anchor) return thaiLang(lang) ? TH_SCOPE_OPTIONS : EN_SCOPE_OPTIONS;
	return thaiLang(lang) ? [`เฉพาะ ${anchor}`, `${anchor} กับ test ของมัน`] : [`only ${anchor}`, `${anchor} plus its tests`];
};

const QUESTION_TEXT: Record<ClarifyGap, { en: string; th: string }> = {
	target: { en: "what exactly should change? pick one:", th: "จะให้เปลี่ยนอะไรกันแน่ — เลือกหนึ่งข้อ:" },
	observable: { en: "how should the result be checked? pick one:", th: "จะตรวจผลด้วยอะไร — เลือกหนึ่งข้อ:" },
	scope: { en: "how far should the change reach? pick one:", th: "ขอบเขตแค่ไหน — เลือกหนึ่งข้อ:" },
};

const optionsFor = (gap: ClarifyGap, draft: { goal: string; cases: string[] }, choices: ClarifyChoices | undefined, lang?: string): string[] => {
	const thai = thaiLang(lang);
	if (gap === "observable") return thai ? TH_OBSERVE_OPTIONS : EN_OBSERVE_OPTIONS;
	if (gap === "scope") return scopeOptions(draft, lang);
	const given = uniqueOptions(choices?.targets, clarifyChrome(lang).asIs);
	return given.length ? given.slice(0, CLARIFY_MAX) : thai ? TH_TARGET_OPTIONS : EN_TARGET_OPTIONS;
};

export const clarifyQuestions = (gaps: readonly ClarifyGap[], draft: ClarifyDraft, choices: ClarifyChoices, lang?: string): ClarifyQuestion[] => {
	const words = clarifyChrome(lang);
	const parsed = draftOf(draft);
	const thai = thaiLang(lang);
	return orderedGaps(gaps).map((gap) => ({
		gap,
		question: QUESTION_TEXT[gap][thai ? "th" : "en"],
		options: [...uniqueOptions(optionsFor(gap, parsed, choices, lang), words.asIs).slice(0, CLARIFY_MAX), words.asIs],
	}));
};

const usableAnswer = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const text = collapse(value);
	if (!text || AS_IS_TEXTS.has(text.toLowerCase())) return undefined;
	return text;
};

const CLAUSE_LABEL: Record<ClarifyGap, { en: string; th: string }> = {
	target: { en: "target", th: "เป้าหมาย" },
	observable: { en: "check", th: "ตรวจด้วย" },
	scope: { en: "scope", th: "ขอบเขต" },
};

export const applyAnswers = (draft: ClarifyDraft, answers: Partial<Record<ClarifyGap, string>>, lang?: string): ClarifyApplied => {
	const base = draftOf(draft);
	const cases = [...base.cases];
	const notes: string[] = [];
	const answered = new Set<ClarifyGap>();
	for (const gap of CLARIFY_GAPS) {
		const answer = usableAnswer(answers?.[gap]);
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

export const clarifyPlan = (draft: ClarifyDraft, state: ClarifyAnswerState | undefined, goalKey: string, choices: ClarifyChoices, lang?: string): ClarifyPlan => {
	const gaps = clarifyGaps(draft);
	const ask = gaps.length > 0 && clarifyOpen(state, goalKey);
	return { ask, gaps, questions: ask ? clarifyQuestions(gaps, draft, choices, lang) : [] };
};

export const clarifyNote = (open: readonly ClarifyGap[], lang?: string): string => {
	const gaps = orderedGaps(open);
	if (!gaps.length) return thaiLang(lang) ? "ไม่ต้องถามเพิ่ม: goal นี้ชัดพอจะยืนยันแล้ว" : "nothing to ask: this goal is specific enough to confirm";
	return thaiLang(lang) ? `ยังขาด ${gaps.join(", ")} — ${TH_CHROME.note}` : `still missing ${gaps.join(", ")} — ${EN_CHROME.note}`;
};
