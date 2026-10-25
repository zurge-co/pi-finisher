import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const JOURNAL_DIR = "finisher";
export const JOURNAL_FILE = "laps.jsonl";
export const JOURNAL_MAX_TEXT = 240;
export const JOURNAL_MAX_RECORDS = 5_000;

export const globalFinisherDir = (home = homedir()): string => join(home, ".pi", JOURNAL_DIR);
export const journalPath = (home = homedir()): string => join(globalFinisherDir(home), JOURNAL_FILE);

export interface GapCase {
	id: string;
	result: string;
	reason?: string;
}

export interface LapGap {
	kind: "gap";
	at: number;
	repo: string;
	goal: string;
	round: number;
	lap: number;
	laps: number;
	added: string[];
	cases: GapCase[];
	models?: string[];
	outcome?: string;
}

export interface LapDone {
	kind: "done";
	at: number;
	repo: string;
	goal: string;
	rounds: number;
	laps: number;
	outcome: "verified" | "needs-human" | "halted";
}

export type JournalRecord = LapGap | LapDone;

const clip = (s: string, n = JOURNAL_MAX_TEXT): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export const journalEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.FINISHER_NO_JOURNAL !== "1";

export const gapRecord = (input: {
	repo: string;
	goal: string;
	round: number;
	lap: number;
	laps: number;
	added: string[];
	cases: GapCase[];
	models?: (string | undefined)[];
	outcome?: string;
	at?: number;
}): LapGap => ({
	kind: "gap",
	at: input.at ?? Date.now(),
	repo: clip(input.repo, 200),
	goal: clip(input.goal),
	round: input.round,
	lap: input.lap,
	laps: input.laps,
	added: input.added.map((t) => clip(t)).slice(0, 12),
	cases: input.cases.slice(0, 24).map((c) => ({ id: clip(c.id, 80), result: clip(c.result, 20), ...(c.reason ? { reason: clip(c.reason, 300) } : {}) })),
	...(input.models?.filter((m): m is string => !!m)?.length ? { models: [...new Set(input.models.filter((m): m is string => !!m))].slice(0, 8) } : {}),
	...(input.outcome ? { outcome: clip(input.outcome, 40) } : {}),
});

export const doneRecord = (input: { repo: string; goal: string; rounds: number; laps: number; outcome: LapDone["outcome"]; at?: number }): LapDone => ({
	kind: "done",
	at: input.at ?? Date.now(),
	repo: clip(input.repo, 200),
	goal: clip(input.goal),
	rounds: input.rounds,
	laps: input.laps,
	outcome: input.outcome,
});

export const appendRecord = (path: string, record: JournalRecord): boolean => {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
		return true;
	} catch {
		return false;
	}
};

export const isGap = (r: unknown): r is LapGap => {
	const g = r as LapGap | undefined;
	return (
		g?.kind === "gap" &&
		typeof g.at === "number" &&
		typeof g.goal === "string" &&
		typeof g.round === "number" &&
		typeof g.lap === "number" &&
		typeof g.laps === "number" &&
		typeof g.repo === "string" &&
		Array.isArray(g.added) &&
		Array.isArray(g.cases) &&
		g.cases.every((c) => typeof c?.id === "string" && typeof c?.result === "string")
	);
};

export const isDone = (r: unknown): r is LapDone => {
	const d = r as LapDone | undefined;
	return d?.kind === "done" && typeof d.at === "number" && typeof d.goal === "string" && typeof d.rounds === "number" && typeof d.laps === "number";
};

export const parseJournal = (text: string): JournalRecord[] => {
	const out: JournalRecord[] = [];
	for (const line of text.split("\n")) {
		const body = line.trim();
		if (!body) continue;
		try {
			const parsed = JSON.parse(body) as unknown;
			if (isGap(parsed) || isDone(parsed)) out.push(parsed);
		} catch {
		}
	}
	return out.slice(-JOURNAL_MAX_RECORDS);
};

export const readJournal = (home = homedir()): JournalRecord[] => {
	const path = journalPath(home);
	if (!existsSync(path)) return [];
	try {
		return parseJournal(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
};

export const GAP_THEMES: { theme: string; match: RegExp }[] = [
	{ theme: "unproven (no command)", match: /\b(no command was run|never declared a result|no command reports|never recorded|no command was named)\b/i },
	{ theme: "unproven (cannot exercise)", match: /\b(could not exercise|cannot be exercised|needs a human)\b/i },
	{ theme: "unrunnable check", match: /\b(never produced a result|blocked|rpc error|timeout)\b/i },
	{ theme: "contradiction", match: /\b(contradicts|contradiction)\b/i },
	{ theme: "wrote the repo while proving it", match: /\bchanged the working tree\b/i },
	{ theme: "real failure", match: /(exited [1-9]|exited with code [1-9])/i },
];

export const themeOf = (reason: string | undefined): string => {
	const text = reason ?? "";
	for (const t of GAP_THEMES) if (t.match.test(text)) return t.theme;
	return text ? "other" : "no reason given";
};

export interface GapSummary {
	gaps: number;
	goals: number;
	extraLaps: number;
	themes: [string, number][];
	topMissing: [string, number][];
	lastAt?: number;
}

export const summarizeGaps = (records: JournalRecord[], top = 8): GapSummary => {
	const gaps = records.filter((r): r is LapGap => r.kind === "gap");
	const done = records.filter((r): r is LapDone => r.kind === "done");
	const themes = new Map<string, number>();
	const missing = new Map<string, number>();
	for (const g of gaps) {
		for (const c of g.cases ?? []) {
			const theme = themeOf(c.reason);
			themes.set(theme, (themes.get(theme) ?? 0) + 1);
			if (c.reason) missing.set(clip(c.reason, 120), (missing.get(clip(c.reason, 120)) ?? 0) + 1);
		}
	}
	const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
	const lastAt = records.length ? records[records.length - 1].at : undefined;
	return {
		gaps: gaps.length,
		goals: new Set([...gaps.map((g) => g.goal), ...done.map((d) => d.goal)]).size,
		extraLaps: gaps.reduce((n, g) => n + (g.added?.length ?? 0), 0),
		themes: sorted(themes),
		topMissing: sorted(missing),
		...(lastAt ? { lastAt } : {}),
	};
};

export const summaryLines = (summary: GapSummary, cap = 6): string[] => {
	if (!summary.gaps) return ["no extra lap has been needed yet — nothing to analyse"];
	return [
		`${summary.gaps} gap(s) across ${summary.goals} goal(s) → ${summary.extraLaps} extra lap(s)`,
		...summary.themes.slice(0, cap).map(([theme, n]) => `  ${String(n).padStart(3)}  ${theme}`),
		...(summary.topMissing.length ? ["most repeated reason:", ...summary.topMissing.slice(0, cap).map(([why, n]) => `  ${String(n).padStart(3)}  ${why}`)] : []),
	];
};
