import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { finisherDir } from "./types.ts";

export type ConsultMode = "auto" | "always" | "off";

export type TurnIntent = "decide" | "work" | "consult";

export const CONSULT_MODES: readonly ConsultMode[] = ["auto", "always", "off"];

export const DEFAULT_CONSULT_MODE: ConsultMode = "auto";

export const DEFAULT_TURN_INTENT: TurnIntent = "decide";

const MODE_ALIASES: Record<string, ConsultMode> = { decide: "auto" };

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

const modeOf = (raw: unknown): ConsultMode | undefined => {
	const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if ((CONSULT_MODES as readonly string[]).includes(text)) return text as ConsultMode;
	return MODE_ALIASES[text];
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

const INTENT_BY_MODE: Record<ConsultMode, TurnIntent> = { auto: "decide", always: "consult", off: "work" };

export const intentOf = (mode: ConsultMode): TurnIntent => INTENT_BY_MODE[mode] ?? DEFAULT_TURN_INTENT;

export const turnIntent = (mode: ConsultMode | undefined): TurnIntent => intentOf(consultMode(mode));

export const turnRuns = (intent: TurnIntent | undefined): boolean => (intent ?? DEFAULT_TURN_INTENT) !== "consult";

export const goalStartsRun = (intent: TurnIntent | undefined, start?: boolean): boolean => start === true || turnRuns(intent);

export const consultOnly = (intent: TurnIntent | undefined, start?: boolean): boolean => start !== true && intent === "consult";

export const worksTurn = (intent: TurnIntent | undefined, start?: boolean): boolean => !consultOnly(intent, start);

export const goalOpenFor = (goal: { doneAt?: number } | undefined): boolean => Boolean(goal) && !goal?.doneAt;

export const shouldClarify = (intent: TurnIntent | undefined, start: boolean, askClarify: boolean): boolean => askClarify && goalStartsRun(intent, start);

export const consultNote = (lang?: string): string =>
	thaiLang(lang)
		? "ตอนนี้คุยกันอยู่ ไม่มี goal เปิด: ตอบ/ปรึกษาได้เลย จะเริ่มงานเมื่อไหร่ค่อยเรียก goal ด้วย start: true"
		: "this is a conversation, not a goal run: answer or think with the human, and call goal with start: true when the work really starts";

export const noGoalNeededNote = (toolName: string, lang?: string): string =>
	thaiLang(lang)
		? `${toolName}: ยังไม่มี goal เปิด และตอนนี้อยู่ในโหมดคุยปรึกษา — ไม่ต้องมี goal ก็ตอบได้ คุยกับมนุษย์ต่อ หรือถ้าจะเริ่มงานจริงให้เรียก goal ด้วย start: true ก่อน`
		: `${toolName}: no goal is open and this turn is a conversation — nothing needs a goal here, so keep talking, or call goal with start: true when the work really starts`;

export const codeConsultNote = (lang?: string): string =>
	thaiLang(lang)
		? "code: เทิร์นนี้เป็นการคุยปรึกษา จึงยังไม่ปล่อย coder ลงมือ — คุยต่อได้เลย ถ้าจะลงมือจริงให้เรียก goal ด้วย start: true ก่อนแล้วค่อย fan out"
		: "code: this turn is a conversation, so no coder was spawned — keep talking, and call goal with start: true before you fan out";

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

export const decideDirective = (prompt: string, lang?: string): string => {
	const line = (typeof prompt === "string" ? prompt : "").replace(/\s+/g, " ").trim().slice(0, 120);
	if (thaiLang(lang))
		return `โหมด auto (มนุษย์ไม่ได้บังคับ): ${line ? `มนุษย์เขียนว่า "${line}" — ` : ""}ตัดสินเองก่อนว่าข้อความนี้คือการคุยหรือคำสั่งงาน แล้วจึงลงมือ. ถ้าเป็นการคุย (คำถาม ตรวจพฤติกรรมเดิม เทียบทางเลือก คิดออกเสียง) ให้ตอบเลย ไม่ต้องเรียก goal ไม่มี dialog ไม่มี lap/verify อ่านโค้ดเพื่อตอบได้ฟรี. ถ้าเป็นคำสั่งงาน (ให้แก้ ให้เพิ่ม ให้ซ่อม หรือ "ลงมือได้") ให้เรียก goal ด้วย start: true พร้อม goal และ case ที่ร่างจากคำพูดของมนุษย์เอง แล้วลงมือ. ถ้าตัดสินไม่ได้ ให้ตอบเป็นการคุยก่อน — run ที่มนุษย์ไม่ได้สั่งแพงกว่าหนึ่งประโยค`;
	return `auto mode (the human forced nothing): ${line ? `the human wrote "${line}" — ` : ""}decide first whether this message is a conversation or a work order, then act. A conversation (a question, a check on existing behaviour, a comparison of options, thinking out loud) gets an answer: no goal, no dialog, no lap/verify, and exploratory reads are free. A work order (change this, add that, fix a bug, or 'go') is a run: call goal with start: true and the cases drafted from the human's own words, then start. When you cannot tell, answer it as a conversation first — a run the human did not ask for costs more than one sentence.`;
};

export const decideGoalNote = (lang?: string): string =>
	thaiLang(lang)
		? "โหมด auto: ผมตัดสินแล้วว่าข้อความนี้เป็นงาน จึงเรียก goal เองโดยไม่ต้องมี start: true — start: true เป็นของมนุษย์ตอนสั่งลงมือในโหมดคุย"
		: "auto mode: I read this message as a work order and called goal on my own — start: true belongs to the human saying go during a conversation";

export const modeSwitchNote = (mode: ConsultMode, lang?: string): string => {
	const line = intentOf(mode);
	if (thaiLang(lang)) {
		if (line === "consult") return "สลับโหมดเป็น always: ต่อจากนี้ทุกเทิร์นเป็นการคุย ไม่มี goal ไม่มี dialog จนกว่าจะเรียก goal ด้วย start: true";
		if (line === "work") return "สลับโหมดเป็น off: ทุกเทิร์นถือเป็นงาน — เรียก goal ก่อนลงมือทุกครั้ง";
		return "สลับโหมดเป็น auto: เทิร์นต่อไปให้ผมตัดสินเองว่าข้อความนี้คือการคุยหรือคำสั่งงาน";
	}
	if (line === "consult") return "mode switched to always: every turn is a conversation — no goal, no dialog until goal is called with start: true";
	if (line === "work") return "mode switched to off: every turn is a work order — goal is called before any work starts";
	return "mode switched to auto: from the next turn I decide whether the message is a conversation or a work order";
};

export const CONSULT_GUIDELINE =
	"The human held this session as a conversation (consultMode: always): answer, ask back, compare options and think with them — do NOT call goal, do NOT open a confirm dialog, and do NOT declare a plan because a question is on the table. Exploratory reads are allowed here, so reading the code to answer well is your job. When the human says go, call goal with start: true.";

export const INTENT_GUIDELINE =
	"You decide what the human's message is — a conversation you answer, or a work order you run — and nothing in the harness inspects their words for you. A question, a check on how something already behaves, a comparison of options, or thinking out loud is a conversation: it never calls goal, opens no dialog, declares no plan, and exploratory reads are free because reading the code is how you answer well. An instruction to change something, a bug to fix, a feature to add, or 'go' on something already agreed is a work order: that is a run, so call goal with start: true and the cases it stands on. When the message could be either, answer it as a conversation first — a run the human did not ask for costs them a dialog, a plan and laps they never wanted, while answering first costs one sentence.";
