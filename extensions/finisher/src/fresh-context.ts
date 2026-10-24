import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finisherDir } from "./types.ts";
import { allLapsDone, planOf, totalPhases } from "./goal-phase.ts";
import { renderLapTracker, type LapTracker } from "./lap-tracker.ts";

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

export const clipSummary = (text: string, max = FRESH_SUMMARY_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export const FRESH_DEBOUNCE_MS = 2_000;

export const LAP_DIRECTIVE =
	"[finisher fresh context] a lap just closed; the work that produced it was summarized on purpose so the next lap starts clean. The lap tracker below is the state that matters — re-read the repo and the tracker on disk instead of trusting memory.";

export const LAP_TRACKER_BUDGET = FRESH_SUMMARY_MAX - LAP_DIRECTIVE.length - 4;

export const lapCompactionSummary = (tracker: LapTracker): string => clipSummary([LAP_DIRECTIVE, renderLapTracker(tracker, LAP_TRACKER_BUDGET)].join("\n\n"));

export interface FreshLapState {
	enabled: boolean;
	hasWork: boolean;
	aborted?: boolean;
	lastResetAt?: number;
	goal?: { doneAt?: number; phases?: { id: string; text: string; round: number; addedAt: number }[]; lap?: number; lapAt?: number; lapMs?: number[] };
	consumedLapAt?: number;
	reportUnread?: boolean;
	now?: number;
}

export const lapBoundaryOpen = (goal: FreshLapState["goal"]): boolean => {
	if (!goal || goal.doneAt) return false;
	const plan = planOf(goal);
	if (!totalPhases(plan) || allLapsDone(plan)) return false;
	return plan.lap > 1;
};

export const freshLapDecision = (o: FreshLapState): { reset: boolean; lapAt?: number; lap?: number } => {
	const now = o.now ?? Date.now();
	const plan = planOf(o.goal);
	const reset =
		o.enabled &&
		o.hasWork &&
		!o.aborted &&
		o.reportUnread !== true &&
		lapBoundaryOpen(o.goal) &&
		plan.lapAt !== o.consumedLapAt &&
		!((o.lastResetAt ?? 0) > now - FRESH_DEBOUNCE_MS);
	return reset ? { reset: true, lapAt: plan.lapAt, lap: plan.lap } : { reset: false };
};

export const isTrackerEntry = (entry: { type?: string; customType?: string } | undefined): boolean => entry?.type === "custom" && entry.customType === "finisher-tracker";

export const freshCompactionEntry = (summary: string): { type: "compaction"; summary: string; firstKeptEntryId: string | null } => ({
	type: "compaction",
	summary: clipSummary(summary),
	firstKeptEntryId: null,
});

export const trackerEntryDraft = (summary: string): { type: "custom_message"; customType: string; content: string; display: boolean } => ({
	type: "custom_message",
	customType: "finisher-tracker",
	content: summary,
	display: false,
});
