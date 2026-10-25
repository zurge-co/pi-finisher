import { type Spec } from "./types.ts";
import { baseLang, DEFAULT_GOAL_LANG } from "./human-language.ts";

export type GoalGateState = "unconfirmed" | "confirmed";

export interface GoalConfirmState {
	goal: string;
	confirmedAt?: number;
	signature?: string;
}

export const goalGate = (g: GoalConfirmState | undefined): GoalGateState => (g?.confirmedAt ? "confirmed" : "unconfirmed");

export const confirmGoal = (g: GoalConfirmState, at = Date.now()): GoalConfirmState => ({
	...g,
	confirmedAt: at,
	signature: `${g.goal.trim().toLowerCase()}@${at}`,
});

export const goalCases = (spec: Pick<Spec, "crossCheck" | "outcomes" | "intent">): string[] => {
	const cases = (spec.crossCheck ?? []).map((c) => c.trim()).filter(Boolean);
	if (cases.length) return cases;
	const legacy = (spec.outcomes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	if (legacy.length) return legacy;
	return [spec.intent.trim()];
};

export const buildGoalConfirmPrompt = (goal: string, cases: string[]): string =>
	[
		`Confirm this goal once — after confirming, no further approval is asked for: ${goal.trim() || "(no goal stated)"}`,
		"",
		"The goal is met when every case below is true of the real result:",
		...cases.map((c, i) => `  ${i + 1}. ${c}`),
		"",
		"After confirming: the agent picks its own approach, verifies the result itself and keeps working until every case holds. No gates, no second signature.",
	].join("\n");

export const GOAL_AFTER_CONFIRM_NOTE = "goal confirmed — no gate between here and the result; verify every case and report once at the end";

export type GoalAskOutcome = "confirmed" | "declined" | "unavailable" | "timeout";

export const GOAL_CONFIRM_TITLE = "▚ confirm this goal once";
export const GOAL_CONFIRM_KEYS = "y / enter = confirm  •  n / esc = decline";

export interface GoalChrome {
	title: string;
	keys: string;
	keysLine: string;
	header: string;
	note: string;
	emptyGoal: string;
}

const EN_CHROME: GoalChrome = {
	title: GOAL_CONFIRM_TITLE,
	keys: GOAL_CONFIRM_KEYS,
	keysLine: "↑↓ / wheel = scroll  •  space = read the chat without closing",
	header: "the goal is met when every case below is true of the real result:",
	note: "after you confirm: no further approval, no token or cost ceiling — every case is verified and the report comes once.",
	emptyGoal: "(no goal stated)",
};

const TH_CHROME: GoalChrome = {
	title: "▚ ยืนยันเป้าหมายครั้งเดียว",
	keys: "y / enter = ยืนยัน  •  n / esc = ไม่ยืนยัน",
	keysLine: "↑↓ / wheel = เลื่อน  •  space = อ่านแชทโดยไม่ปิดกล่อง",
	header: "เป้าหมายนี้สำเร็จเมื่อทุกข้อด้านล่างเป็นจริงกับผลลัพธ์จริง:",
	note: "หลังยืนยัน: ไม่มีการขออนุมัติอีก ไม่มีเพดานโทเคนหรือค่าใช้จ่าย — ทุกข้อจะถูกพิสูจน์ และรายงานครั้งเดียวตอนจบ",
	emptyGoal: "(ยังไม่ได้ระบุเป้าหมาย)",
};

const CHROME: Record<string, GoalChrome> = { en: EN_CHROME, th: TH_CHROME };

export type GoalChromeOverrides = Partial<Record<keyof GoalChrome, string>>;

export const CHROME_TEXT_MAX = 120;

const usable = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.trim().length <= CHROME_TEXT_MAX && !/[\n\r\t]/.test(v) && !/[\u0000-\u001F\u007F]/.test(v);

export const cleanChrome = (overrides: GoalChromeOverrides | undefined): GoalChromeOverrides => {
	const out: GoalChromeOverrides = {};
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (!usable(value)) continue;
		out[key as keyof GoalChrome] = value.trim();
	}
	return out;
};

export const goalChrome = (lang?: string, overrides?: GoalChromeOverrides): GoalChrome => {
	const tag = lang ?? DEFAULT_GOAL_LANG;
	const base = CHROME[tag] ?? CHROME[baseLang(tag)] ?? EN_CHROME;
	return { ...base, ...cleanChrome(overrides) };
};

export const GOAL_TOO_MANY_CASES = 24;

export const NON_GOAL_PREFIX = "verify: ";

export type GoalConfirmLineKind = "goal" | "blank" | "header" | "case" | "note";

export interface GoalConfirmLine {
	kind: GoalConfirmLineKind;
	text: string;
}

export const goalConfirmLines = (goal: string, cases: string[], lang?: string, chrome?: GoalChromeOverrides): GoalConfirmLine[] => {
	const words = goalChrome(lang, chrome);
	return [
		{ kind: "goal", text: goal.trim() || words.emptyGoal },
		{ kind: "blank", text: "" },
		{ kind: "header", text: words.header },
		...cases.map((c, i) => ({ kind: "case" as const, text: `${i + 1}. ${c}` })),
		{ kind: "blank", text: "" },
		{ kind: "note", text: words.note },
	];
};

export const tooManyCasesNote = (n: number): string =>
	`finisher_goal: ${n} cases is too many for one confirmation to be honest — the human cannot weigh that list. Group them into at most ${GOAL_TOO_MANY_CASES} cases the human can read, then ask once. Nothing was started.`;

export const caseKey = (c: string): string => c.replace(/\s+/g, " ").trim().toLowerCase();

export const GOAL_UNCHANGED_NOTE =
	"the goal is unchanged, so it was NOT asked again: a goal the human already confirmed is never re-confirmed, and changing which cases prove it is the agent's own plan, not the human's decision. Continuing the same goal.";

export const GOAL_ALREADY_VERIFIED_NOTE =
	"this exact goal was already confirmed and verified, so it is not re-opened — reopening it would restart work the human never asked for again. Report the result; to continue, state the new goal the human wants and let them confirm that one.";

export const GOAL_TIMEOUT_NOTE = (seconds: number): string =>
	[
		`⏱ nobody answered the goal dialog within ${seconds}s, so the goal was NOT confirmed and NOTHING was started.`,
		"STOP here. Do not open the dialog again, do not start the work, do not guess the cases, and do not continue an earlier plan.",
		"report this timeout to the human once and wait: the work only resumes when the human asks for it again, with the goal they want.",
	].join("\n");

export interface GoalConsent {
	humanTurns: number;
	reason: "declined" | "timeout";
	sessionId?: string;
}

export interface ConsentView {
	humanTurns: number;
	sessionId?: string;
}

export const UNKNOWN_HUMAN_TURNS = -1;
export const UNKNOWN_SESSION = "";

export const sessionIdFrom = (sessionManager: { getSessionId?: () => unknown } | undefined): string => {
	try {
		const id = sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id : UNKNOWN_SESSION;
	} catch {
		return UNKNOWN_SESSION;
	}
};

export const humanTurnsFrom = (entries: { type?: string; message?: { role?: string } }[]): number => {
	if (!Array.isArray(entries)) return UNKNOWN_HUMAN_TURNS;
	return entries.filter((e) => e?.type === "message" && e?.message?.role === "user").length;
};

export const consentBlocks = (consent: GoalConsent | undefined, view: ConsentView): boolean => {
	if (!consent) return false;
	if (!consent.sessionId || consent.sessionId !== view.sessionId) return false;
	if (view.humanTurns < 0) return false;
	return view.humanTurns === consent.humanTurns;
};

export const consentLifts = (state: { goalConsent?: GoalConsent }): boolean => {
	const had = !!state.goalConsent;
	state.goalConsent = undefined;
	return had;
};

export const humanResumes = (state: { humanAt?: number; goalConsent?: GoalConsent }, at: number): boolean => {
	const cleared = consentLifts(state);
	state.humanAt = at;
	return cleared;
};

export const GOAL_CONSENT_WAIT_NOTE =
	"the human has not said anything since the last goal dialog was refused (declined or timed out), so this run stays stopped. Report the refusal once and wait — do not ask again, do not start work, and do not re-word the goal hoping it passes. A new message from the human resumes it, and only a new message does.";

export const GOAL_DECLINED_NOTE =
	"goal NOT confirmed — the human declined the goal, so nothing was started. Report it once and wait for the human; do not re-word the same goal hoping it passes, and do not begin the work on your own.";

export const unconfirmedGoalNote = (allPass: boolean): string =>
	[
		`no goal was confirmed, so this run did not drive one — the result below is the evidence, and nothing was recorded as the goal:`,
		allPass
			? `every case passed on its own evidence. Present this to the human and call finisher_goal with the goal they want; that dialog is the only thing that turns a case list into a goal.`
			: `at least one case did not pass. Fix the real cause, verify again, and only call finisher_goal once the human is there to confirm the goal.`,
		`(the run is named "verify: …" in the widget because there is no goal to name)`,
	].join("\n");

export const GOAL_NO_UI_NOTE =
	"goal cannot be confirmed: this session has no dialog to ask in (headless/print mode). Run it from the interactive TUI so the human can confirm once, and do not start the work without that yes.";

export const goalConfirmModeLine = (): string =>
	"mode: goal-confirm → autonomous run to a verified result (no per-step approval, no token or cost ceiling, model ladder priority1..priority5 used in parallel)";
