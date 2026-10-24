import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";

export interface GoalStop {
	reason: "declined" | "timeout";
	seconds: number;
	at: number;
	aborted?: boolean;
}

export interface StopHost {
	goalStop?: GoalStop;
}

interface StopWords {
	declined: string;
	timeout: string;
	waiting: string;
}

const TH: StopWords = {
	declined: "⛔ เป้าหมายไม่ได้รับการยืนยัน — ไม่มีอะไรถูกเริ่ม และรันนี้ถูกหยุดแล้ว",
	timeout: "⏱ ไม่มีใครตอบกล่องยืนยันเป้าหมายภายใน {seconds} วินาที — ไม่มีอะไรถูกเริ่ม และรันนี้ถูกหยุดแล้ว",
	waiting: "harness ไม่ถามซ้ำและไม่เริ่มงานเอง: พิมพ์ข้อความใหม่เมื่อพร้อม (แก้เป้าหมาย แก้ case หรือสั่งเรื่องอื่น) แล้วงานจะเริ่มจากข้อความนั้น",
};

const EN: StopWords = {
	declined: "⛔ the goal was NOT confirmed — nothing was started, and this run is stopped.",
	timeout: "⏱ nobody answered the goal dialog within {seconds}s — nothing was started, and this run is stopped.",
	waiting: "the harness asks nothing more and starts nothing on its own: send a new message when you are ready (another goal, another case, or something else) and the work starts from it.",
};

const WORDS: Record<string, StopWords> = { en: EN, th: TH };

export const stopWords = (lang?: HumanLang): StopWords => WORDS[baseLang(lang ?? DEFAULT_GOAL_LANG)] ?? EN;

const stopSeconds = (seconds: number): number => (Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0);

export const goalStopMessage = (stop: Pick<GoalStop, "reason" | "seconds">, lang?: HumanLang): string => {
	const words = stopWords(lang);
	const head = (stop.reason === "timeout" ? words.timeout : words.declined).replace("{seconds}", String(stopSeconds(stop.seconds)));
	return `${head}\n${words.waiting}`;
};

export const goalStopHeadline = (stop: Pick<GoalStop, "reason" | "seconds">, lang?: HumanLang): string => goalStopMessage(stop, lang).split("\n")[0] ?? "";

export const goalStopOf = (host: StopHost | undefined): GoalStop | undefined => host?.goalStop;

export const armGoalStop = (host: StopHost, reason: GoalStop["reason"], seconds: number, at = Date.now()): GoalStop => {
	const stop: GoalStop = { reason, seconds: stopSeconds(seconds), at };
	host.goalStop = stop;
	return stop;
};

export const takeGoalStop = (host: StopHost): GoalStop | undefined => {
	const stop = host.goalStop;
	host.goalStop = undefined;
	return stop;
};

export const claimGoalStopAbort = (host: StopHost): GoalStop | undefined => {
	const stop = host.goalStop;
	if (!stop || stop.aborted) return undefined;
	stop.aborted = true;
	return stop;
};

export const goalStopBlock = (stop: GoalStop, lang?: HumanLang): { block: true; terminate: true; reason: string } => ({
	block: true,
	terminate: true,
	reason: goalStopHeadline(stop, lang),
});

export const goalStopGate = (host: StopHost | undefined, lang?: HumanLang): { block: true; terminate: true; reason: string } | undefined => {
	const stop = goalStopOf(host);
	return stop ? goalStopBlock(stop, lang) : undefined;
};

export const clearGoalStop = (host: StopHost): boolean => takeGoalStop(host) !== undefined;

export const stopLanguage = (host: { goalLang?: string; humanLang?: string } | undefined): HumanLang | undefined =>
	host?.goalLang ?? host?.humanLang;
