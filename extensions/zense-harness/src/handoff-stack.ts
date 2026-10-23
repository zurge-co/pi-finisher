import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir } from "./types.ts";

export const HANDOFF_FILE = "handoff.jsonl";
export const HANDOFF_MAX_ITEMS = 12;
export const HANDOFF_LINE_MAX = 240;
export const HANDOFF_KEEP_THRESHOLD = 0.5;

export interface HandoffItem {
	at: number;
	from: string;
	text: string;
}

export interface HandoffCandidate {
	from: string;
	raw: string;
}

export interface HandoffAnswerLike {
	type?: string;
	probability?: number;
	confidence?: number;
	choice?: string;
	score?: number;
}

export const handoffPath = (cwd: string): string => join(zenseDir(cwd), HANDOFF_FILE);

export const handoffQuestion = (): Record<string, unknown> => ({
	keep: {
		type: "bool",
		instructions:
			"Judge whether this single piece of context would make the NEXT task faster or more correct. Drop anything that is only a statistic, a restatement of the code, or already obvious from the repo.",
		criteria: {
			true: "a fact, decision, or constraint the next task needs to avoid repeating work or repeating a mistake",
			false: "a count, a log line, a file list, a restatement, or noise that does not change what the next task does",
		},
	},
});

export const handoffKeepProbability = (a: HandoffAnswerLike | undefined): number => {
	if (!a) return 0;
	if (typeof a.probability === "number") return a.probability;
	if (typeof a.confidence === "number") return a.confidence;
	if (a.choice === "true") return 1;
	return 0;
};

export const classifyKeep = (a: HandoffAnswerLike | undefined, threshold = HANDOFF_KEEP_THRESHOLD): boolean => handoffKeepProbability(a) >= threshold;

export const condenseLine = (raw: string, max = HANDOFF_LINE_MAX): string => {
	const flat = raw.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	const at = cut.lastIndexOf(" ");
	return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
};

export const isWorthKeeping = (text: string): boolean => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length < 24) return false;
	if (/^(\d+|[\d.]+%?)\s*$/.test(flat)) return false;
	return !/^(ok|done|success|fail(ed)?|true|false|n\/a)$/i.test(flat);
};

export const trimStack = (items: HandoffItem[], cap = HANDOFF_MAX_ITEMS): HandoffItem[] =>
	items.length <= cap ? items : items.slice(items.length - cap);

export const dedupeItem = (items: HandoffItem[], text: string): boolean => {
	const key = text.replace(/\s+/g, " ").trim().toLowerCase();
	return !items.some((i) => i.text.replace(/\s+/g, " ").trim().toLowerCase() === key);
};

export const pushHandoff = (items: HandoffItem[], item: HandoffItem, cap = HANDOFF_MAX_ITEMS): HandoffItem[] => {
	if (!isWorthKeeping(item.text)) return items;
	if (!dedupeItem(items, item.text)) return items;
	return trimStack([...items, { ...item, text: condenseLine(item.text) }], cap);
};

export const readHandoff = (cwd: string): HandoffItem[] => {
	const f = handoffPath(cwd);
	if (!existsSync(f)) return [];
	const out: HandoffItem[] = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const raw = JSON.parse(t) as Partial<HandoffItem>;
			if (typeof raw.text !== "string" || !raw.text.trim()) continue;
			out.push({ at: typeof raw.at === "number" ? raw.at : 0, from: typeof raw.from === "string" ? raw.from : "unknown", text: raw.text });
		} catch {
		}
	}
	return trimStack(out);
};

export const writeHandoff = (cwd: string, items: HandoffItem[]): void => {
	mkdirSync(zenseDir(cwd), { recursive: true });
	writeFileSync(handoffPath(cwd), trimStack(items).map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
};

export const appendHandoff = (cwd: string, item: HandoffItem): HandoffItem[] => {
	const next = pushHandoff(readHandoff(cwd), item);
	writeHandoff(cwd, next);
	return next;
};

export const stackHead = (items: HandoffItem[]): string | undefined => {
	if (!items.length) return undefined;
	return items[items.length - 1]?.text;
};

export const stackSummary = (items: HandoffItem[], limit = 6): string => {
	const picked = trimStack(items, limit);
	if (!picked.length) return "";
	return picked.map((i) => `- ${i.text}`).join("\n");
};

export const handoffInjection = (items: HandoffItem[], limit = 6): string | undefined => {
	const body = stackSummary(items, limit);
	if (!body) return undefined;
	return `[zense handoff] what earlier tasks learned that this one must not rediscover:\n${body}`;
};

export const distillPrompt = (c: HandoffCandidate, existing: HandoffItem[]): string =>
	[
		`Condense ONE piece of knowledge from the "${c.from}" sub-agent into a single line that makes the NEXT task faster or more correct.`,
		`Rules: one line, no statistics, no file lists, no restating code, no hedging. If it would not change what the next task does, reply exactly: DROP`,
		existing.length ? `Already on the stack (do not repeat):\n${existing.map((i) => `- ${i.text}`).join("\n")}` : "",
		`Candidate:\n${condenseLine(c.raw, 4_000)}`,
	].filter(Boolean).join("\n\n");

export const parseDistilled = (out: string): string | undefined => {
	const line = condenseLine(out.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("```")) ?? "");
	if (!line || /^DROP$/i.test(line)) return undefined;
	return isWorthKeeping(line) ? line : undefined;
};
