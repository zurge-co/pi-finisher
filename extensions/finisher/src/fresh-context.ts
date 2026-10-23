import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finisherDir } from "./types.ts";
import { stackSummary, type HandoffItem } from "./handoff-stack.ts";

export const FRESH_KEY = "freshContext";
export const FRESH_DEFAULT = true;
export const FRESH_SUMMARY_MAX = 1_200;

export interface FreshContextConfig {
	enabled: boolean;
	source: "config" | "default" | "broken-config";
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
	return clipSummary(`[finisher fresh context] a task finished; this context was reset on purpose. What earlier work learned that this one must not rediscover:\n${body}\nRe-read the repo and the tracker from disk instead of trusting memory.`);
};

export const clipSummary = (text: string, max = FRESH_SUMMARY_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export const isOneLineSummary = (text: string): boolean => !text.includes("\n") || text.length <= FRESH_SUMMARY_MAX;

export const shouldReset = (opts: { enabled: boolean; alreadyReset: boolean; hasWork: boolean; aborted?: boolean }): boolean =>
	opts.enabled && !opts.alreadyReset && opts.hasWork && !opts.aborted;

export const freshCompactionEntry = (summary: string): { type: "compaction"; summary: string; firstKeptEntryId: null } => ({
	type: "compaction",
	summary: clipSummary(summary),
	firstKeptEntryId: null,
});

export const freshStatusLine = (cfg: FreshContextConfig, items: HandoffItem[]): string =>
	[
		`fresh context: ${cfg.enabled ? "ON" : "OFF"} (${cfg.source})`,
		`handoff stack: ${items.length} item(s)${items.length ? "" : " — nothing worth carrying yet"}`,
	].join("\n");
