import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { finisherDir } from "./types.ts";

export type ConsultMode = "auto" | "always" | "off";

export type TurnIntent = "consult" | "work";

export const CONSULT_MODES: readonly ConsultMode[] = ["auto", "always", "off"];

export const DEFAULT_CONSULT_MODE: ConsultMode = "auto";

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

const modeOf = (raw: unknown): ConsultMode | undefined => {
	const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return (CONSULT_MODES as readonly string[]).includes(text) ? (text as ConsultMode) : undefined;
};

export const consultMode = (raw: unknown, fallback: ConsultMode = DEFAULT_CONSULT_MODE): ConsultMode => modeOf(raw) ?? fallback;

export const consultModeFromJson = (raw: Record<string, unknown> | undefined): ConsultMode => consultMode(raw?.consultMode);

export const readConsultMode = (cwd: string, env: Record<string, string | undefined> = process.env): ConsultMode => {
	const fromEnv = modeOf(env.FINISHER_CONSULT_MODE);
	if (fromEnv) return fromEnv;
	const file = join(finisherDir(cwd), "config.json");
	if (!existsSync(file)) return DEFAULT_CONSULT_MODE;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return consultModeFromJson(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined);
	} catch {
		return DEFAULT_CONSULT_MODE;
	}
};

export const turnIntent = (mode: ConsultMode | undefined): TurnIntent => (mode === "always" ? "consult" : "work");

export const goalStartsRun = (intent: TurnIntent | undefined, start?: boolean): boolean => start === true || intent === "work";

export const consultOnly = (intent: TurnIntent | undefined, start?: boolean): boolean => intent === "consult" && start !== true;

export const worksTurn = (intent: TurnIntent | undefined, start?: boolean): boolean => !consultOnly(intent, start);

export const shouldClarify = (intent: TurnIntent | undefined, start: boolean, askClarify: boolean): boolean => askClarify && goalStartsRun(intent, start);

export const consultNote = (lang?: string): string =>
	thaiLang(lang)
		? "ตอนนี้คุยกันอยู่ ไม่มี goal เปิด: ตอบ/ปรึกษาได้เลย จะเริ่มงานเมื่อไหร่ค่อยเรียก goal ด้วย start: true"
		: "this is a conversation, not a goal run: answer or think with the human, and call goal with start: true when the work really starts";

export const noGoalNeededNote = (toolName: string, lang?: string): string =>
	thaiLang(lang)
		? `${toolName}: ยังไม่มี goal เปิด และตอนนี้อยู่ในโหมดคุยปรึกษา — ไม่ต้องมี goal ก็ตอบได้ คุยกับมนุษย์ต่อ หรือถ้าจะเริ่มงานจริงให้เรียก goal ด้วย start: true ก่อน`
		: `${toolName}: no goal is open and this turn is a conversation — nothing needs a goal here, so keep talking, or call goal with start: true when the work really starts`;

export const goalConsultNote = (lang?: string): string =>
	thaiLang(lang)
		? "goal: เทิร์นนี้เป็นการคุยปรึกษา จึงไม่เปิด dialog และไม่เริ่ม run — คุยต่อได้เลย ถ้าจะลงมือจริงให้เรียก goal ด้วย start: true"
		: "goal: this turn is a conversation, so no dialog was opened and no run was started — keep talking, and call goal with start: true when the work really starts";

export const consultDirective = (prompt: string, lang?: string): string => {
	const line = (typeof prompt === "string" ? prompt : "").replace(/\s+/g, " ").trim().slice(0, 120);
	if (thaiLang(lang))
		return `โหมดคุยปรึกษา (มนุษย์ตั้ง consultMode เป็น always): ${line ? `มนุษย์กำลังถาม/คุยเรื่อง "${line}" — ` : ""}ตอบเป็นผู้ช่วยคิดได้เลย ไม่ต้องเรียก goal ไม่มี dialog ไม่มี lap/verify. จะเริ่มงานจริงเมื่อมนุษย์สั่งลงมือ หรือเมื่อข้อความนั้นเป็นคำสั่งงานชัด ๆ ก็เรียก goal ด้วย start: true`;
	return `consult mode (the human set consultMode to always): ${line ? `the human is asking about "${line}" — ` : ""}answer as a thinking partner: no goal, no dialog, no lap/verify. Start a run only when the human says go — then call goal with start: true`;
};

export const CONSULT_GUIDELINE =
	"The human held this session as a conversation (consultMode: always): answer, ask back, compare options and think with them — do NOT call goal, do NOT open a confirm dialog, and do NOT declare a plan because a question is on the table. Exploratory reads are allowed here, so reading the code to answer well is your job. When the human says go, call goal with start: true.";

export const INTENT_GUIDELINE =
	"You decide what the human's message is — a conversation you answer, or a work order you run — and nothing in the harness inspects their words for you. A conversation never calls goal: no dialog, no plan, no verify, and exploratory reads are free here because reading the code is how you answer well. The moment their message is a work order, or they say go, it is a run: call goal with start: true and the cases it stands on.";
