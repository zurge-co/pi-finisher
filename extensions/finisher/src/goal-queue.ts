import { freshGoalRun, goalKey } from "./goal-driver.ts";
import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";
import { type QueuedGoal } from "./types.ts";

export const GOAL_QUEUE_MAX = 8;

export const goalQueueOf = (state: { goalQueue?: QueuedGoal[] }): QueuedGoal[] => state.goalQueue ?? [];

export const queueIndexOf = (queue: QueuedGoal[], goal: string): number => queue.findIndex((q) => goalKey(q.goal) === goalKey(goal));

export interface EnqueueResult {
	ok: boolean;
	queue: QueuedGoal[];
	position: number;
}

export const enqueueGoal = (queue: QueuedGoal[], entry: QueuedGoal): EnqueueResult => {
	const at = queueIndexOf(queue, entry.goal);
	if (at >= 0) {
		const current = queue[at];
		const next = [...queue];
		next[at] = { ...current, ...entry, queuedAt: current.queuedAt };
		return { ok: true, queue: next, position: at + 1 };
	}
	if (queue.length >= GOAL_QUEUE_MAX) return { ok: false, queue, position: 0 };
	return { ok: true, queue: [...queue, entry], position: queue.length + 1 };
};

export interface QueueHost {
	goalDriver?: unknown;
	goalQueue?: QueuedGoal[];
	goalLang?: string;
	goalChrome?: QueuedGoal["chrome"];
	decisions?: { at: number; from: string; question: string; assumption: string }[];
}

export const advanceGoalQueue = (state: QueueHost, at = Date.now()): QueuedGoal | undefined => {
	const queue = goalQueueOf(state);
	const next = queue[0];
	state.goalQueue = queue.length > 1 ? queue.slice(1) : undefined;
	if (!next) return undefined;
	state.goalDriver = freshGoalRun(next.goal, at, next.cases);
	if (next.lang) state.goalLang = next.lang;
	state.goalChrome = next.chrome;
	state.decisions = (next.notes ?? []).map((note) => ({ at, from: "clarify", question: "the human made the intent concrete", assumption: note }));
	return next;
};

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

export const goalQueuedNote = (goal: string, position: number, total: number, current: string, lang?: string): string =>
	thaiLang(lang)
		? `goal ใหม่ยืนยันแล้วและเข้าคิวเป็นลำดับที่ ${position}/${total}: "${goal}" — goal ปัจจุบัน ("${current}") ยังทำต่อจนกว่าจะปิด (verified / needs-human / halted) แล้วงานหัวคิวจะเลื่อนขึ้นมาเป็น goal ใหม่เองโดยไม่ต้องยืนยันอีก`
		: `the new goal is confirmed and queued at position ${position}/${total}: "${goal}" — the current goal ("${current}") keeps running until it closes (verified / needs-human / halted); the head of the queue is then promoted with no second confirmation`;

export const goalQueueFullNote = (max: number, lang?: string): string =>
	thaiLang(lang)
		? `คิว goal เต็มแล้ว (${max} งาน) — goal นี้ยืนยันแล้วแต่เข้าคิวไม่ได้ รอให้ goal ปัจจุบันหรืองานในคิวปิดก่อนแล้วค่อยเรียก goal อีกครั้ง`
		: `the goal queue is full (${max}) — this goal was confirmed but could not be queued; wait for the current goal or one queued ahead to close, then call goal again`;

export const goalQueueUpdatedNote = (goal: string, position: number, lang?: string): string =>
	thaiLang(lang)
		? `goal นี้อยู่ในคิวอยู่แล้ว (ลำดับที่ ${position}) — ยืนยันไปแล้วครั้งเดียวจึงไม่เปิด dialog ซ้ำ: "${goal}"`
		: `this goal is already queued at position ${position} — it was confirmed once, so no dialog was opened again: "${goal}"`;

export const goalPromotedNote = (goal: string, lang?: string): string =>
	thaiLang(lang)
		? `คิว goal: เลื่อน "${goal}" ขึ้นเป็น goal ปัจจุบันแล้ว — มนุษย์ยืนยันไว้ตอนเข้าคิวจึงไม่เปิด dialog ซ้ำ ประกาศ plan (lap) ของ goal นี้แล้วทำต่อได้เลย`
		: `goal queue: "${goal}" is the current goal now — the human confirmed it when it entered the queue, so no dialog was opened; declare its lap plan and keep working`;

export const goalQueueRefusedNote = (goal: string, current: string, outcome: "declined" | "timeout", seconds: number, lang?: string): string => {
	if (thaiLang(lang))
		return outcome === "timeout"
			? `dialog ยืนยันงานเข้าคิวหมดเวลา (${seconds} วินาที): "${goal}" ไม่ได้เข้าคิว — ไม่มีการหยุดงานและไม่บล็อก tool ใด goal ปัจจุบัน ("${current}") ทำต่อปกติ ถ้าต้องการให้เข้าคิวให้สั่งอีกครั้งในเทิร์นถัดไป`
			: `มนุษย์ปฏิเสธงานเข้าคิว: "${goal}" ไม่ได้เข้าคิว — ไม่มีการหยุดงานและไม่บล็อก tool ใด goal ปัจจุบัน ("${current}") ทำต่อปกติ ไม่ต้องเปิด dialog ถามซ้ำในเทิร์นนี้`;
	return outcome === "timeout"
		? `the queue confirmation dialog timed out (${seconds}s): "${goal}" was not queued — nothing was stopped and no tool is blocked; the current goal ("${current}") keeps running; call goal again on a later human turn to queue it`
		: `the human declined the queued goal: "${goal}" was not queued — nothing was stopped and no tool is blocked; the current goal ("${current}") keeps running; do not reopen the dialog this turn`;
};
