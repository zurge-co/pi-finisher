import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finisherDir } from "./types.ts";
import { stackSummary, type HandoffItem } from "./handoff-stack.ts";

export const FRESH_KEY = "freshContext";
export const FRESH_DEFAULT = true;
export const FRESH_SUMMARY_MAX = 1_200;
export const FRESH_DIRECTIVE = "[finisher fresh context] the confirmed goal is closed; the work that produced it was summarized on purpose so the next task starts clean. Re-read the repo and state from disk instead of trusting memory.";

export interface FreshContextConfig {
	enabled: boolean;
	source: "config" | "default" | "broken-config";
}

export interface FreshResetInput {
	enabled: boolean;
	alreadyReset: boolean;
	hasWork: boolean;
	aborted?: boolean;
	goalDone?: boolean;
	freshBoundary?: boolean;
	reportUnread?: boolean;
}

export const configPath = (cwd: string): string => join(finisherDir(cwd), "config.json");

export const readFreshContextConfig = (cwd: string): FreshContextConfig => {
	const f = configPath(cwd);
	if (!existsSync(f)) return { enabled: FRESH_DEFAULT, source: "default" };
	try {
		const raw = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
		const v = raw[FRESH_KEY];
		if (typeof v === "boolean") return { enabled: v, source: "config" };
		return { enabled: FRESH_DEFAULT, source: "default" };
	} catch {
		return { enabled: FRESH_DEFAULT, source: "broken-config" };
	}
};

export const writeFreshContextConfig = (cwd: string, enabled: boolean): boolean => {
	const f = configPath(cwd);
	try {
		const raw = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
		raw[FRESH_KEY] = enabled;
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, JSON.stringify(raw, null, 2));
		return true;
	} catch {
		return false;
	}
};

export const buildFreshSummary = (items: HandoffItem[], limit = 6): string => {
	const body = stackSummary(items, limit);
	if (!body) return "";
	return clipSummary(`[finisher fresh context] what this run learned that the next one must not rediscover:\n${body}\nRe-read the repo and the tracker from disk instead of trusting memory.`);
};

export const freshDirective = (summary: string): string => summary || FRESH_DIRECTIVE;

export const clipSummary = (text: string, max = FRESH_SUMMARY_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export const isOneLineSummary = (text: string): boolean => !text.includes("\n") || text.length <= FRESH_SUMMARY_MAX;

export const isGoalBoundary = (goal: { doneAt?: number } | undefined, consumedAt: number | undefined): boolean =>
	!!goal?.doneAt && goal.doneAt !== consumedAt;

export const shouldReset = (opts: FreshResetInput): boolean =>
	opts.enabled && !opts.alreadyReset && opts.hasWork && !opts.aborted && opts.reportUnread !== true && opts.goalDone === true && opts.freshBoundary === true;

export const FRESH_DEBOUNCE_MS = 2_000;

export interface FreshResetState {
	enabled: boolean;
	hasWork: boolean;
	aborted?: boolean;
	lastResetAt?: number;
	goal?: { doneAt?: number };
	consumedGoalAt?: number;
	reportUnread?: boolean;
	now?: number;
}

export const freshResetDecision = (o: FreshResetState): { reset: boolean; goalAt?: number } => {
	const now = o.now ?? Date.now();
	const goalAt = o.goal?.doneAt;
	const reset = shouldReset({
		enabled: o.enabled,
		hasWork: o.hasWork,
		aborted: o.aborted,
		alreadyReset: (o.lastResetAt ?? 0) > now - FRESH_DEBOUNCE_MS,
		goalDone: !!goalAt,
		freshBoundary: isGoalBoundary(o.goal, o.consumedGoalAt),
		reportUnread: o.reportUnread,
	});
	return reset ? { reset: true, goalAt } : { reset: false };
};

export interface EntryRef {
	sourceEntry?: { id?: string; type?: string; message?: { role?: string } };
}

export const lastUserEntryId = (entries: EntryRef[]): string | null => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]?.sourceEntry;
		if (e?.type === "message" && e.message?.role === "user" && typeof e.id === "string") return e.id;
	}
	return null;
};

export const freshCompactionEntry = (summary: string, firstKeptEntryId: string | null = null): { type: "compaction"; summary: string; firstKeptEntryId: string | null } => ({
	type: "compaction",
	summary: clipSummary(summary),
	firstKeptEntryId,
});

export const freshStatusLine = (cfg: FreshContextConfig, items: HandoffItem[]): string =>
	[
		`fresh context: ${cfg.enabled ? "ON" : "OFF"} (${cfg.source})`,
		`handoff stack: ${items.length} item(s)${items.length ? "" : " — nothing worth carrying yet"}`,
	].join("\n");
