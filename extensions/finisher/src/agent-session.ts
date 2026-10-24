import { visibleWidth } from "@earendil-works/pi-tui";
import { clip, elapsedLabel } from "./agent-panel.ts";
import { parseLogItems, renderLogItems, toolItemCount, toolToggleHint, TOOL_TOGGLE_KEY } from "./tool-log.ts";
import { type State, type SubagentRun } from "./types.ts";

export const SESSION_MIN_BODY_ROWS = 4;
export const SESSION_TASK_LINES = 10;
export const SESSION_MAX_STEERS = 12;

export interface SteerEvent {
	at: number;
	mode: "steer" | "followUp";
	message: string;
}

export const sessionActive = (runs: SubagentRun[]): boolean => runs.length > 0;

export const runningRunFor = (runs: SubagentRun[], role: string): SubagentRun | undefined => {
	for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status === "running" && runs[i].role === role) return runs[i];
	return undefined;
};

export const recordSteerEvent = (run: SubagentRun | undefined, mode: "steer" | "followUp", message: string, at = Date.now()): boolean => {
	if (!run) return false;
	run.steers = [...(run.steers ?? []), { at, mode, message }];
	return true;
};

export const recordSteerOnRun = (state: State, role: string, mode: "steer" | "followUp", message: string, at = Date.now()): boolean =>
	recordSteerEvent(runningRunFor(state.subagentRuns, role), mode, message, at);

export const orderedSessionRuns = (runs: SubagentRun[]): SubagentRun[] => {
	const live = runs.filter((r) => r.status === "running");
	const finished = runs.filter((r) => r.status !== "running").slice().reverse();
	return [...live, ...finished];
};

export const startSessionIndex = (runs: SubagentRun[]): number => {
	const ordered = orderedSessionRuns(runs);
	const live = ordered.findIndex((r) => r.status === "running");
	return live < 0 ? 0 : live;
};

export const stepSessionIndex = (current: number, total: number, dir: 1 | -1): number => {
	if (total < 1) return 0;
	return ((current + dir) % total + total) % total;
};

export const sessionStatus = (run: SubagentRun, now = Date.now()): string =>
	run.status === "running" ? `▶ ${elapsedLabel(now - (run.startedAt ?? run.at))}` : run.ok ? "✓ done" : "✗ failed";

export const sessionLabel = (run: SubagentRun, index: number, total: number, width = 100, now = Date.now()): string => {
	const head = `${index + 1}/${total} · ${run.role.toUpperCase()} · ${sessionStatus(run, now)}`;
	const meta = [run.slotId, run.model ?? "(ladder)", `${(run.steers ?? []).length} steer`].filter(Boolean).join(" · ");
	return clip(`${head} · ${meta}`, Math.max(20, width));
};

export const sessionTitle = (run: SubagentRun, index: number, total: number, width = 100, now = Date.now()): string =>
	`▚ sub-agent session — ${sessionLabel(run, index, total, width, now)}`;

export const sessionTab = (run: SubagentRun, index: number): string => {
	const state = run.status === "running" ? "▶" : run.ok ? "✓" : "✗";
	const name = [run.role.toUpperCase(), run.slotId, run.model].filter(Boolean).join(" ");
	return `${index + 1}:${name} ${state}`;
};

export const SESSION_TABS_PREFIX = "▚ pages ";

export const cutToWidth = (text: string, max: number): string => {
	if (visibleWidth(text) <= max) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (used + w > Math.max(0, max - 1)) break;
		out += ch;
		used += w;
	}
	return `${out}…`;
};

export const sessionTabs = (runs: SubagentRun[], current: number, width = 100): string => {
	const ordered = orderedSessionRuns(runs);
	if (!ordered.length) return "";
	const max = Math.max(20, width);
	const tabs = ordered.map((r, i) => sessionTab(r, i));
	const at = Math.max(0, Math.min(current, tabs.length - 1));
	const render = (lo: number, hi: number): string =>
		`${SESSION_TABS_PREFIX}${lo > 0 ? "… " : ""}${tabs.map((t, i) => (i === at ? `[${t}]` : t)).slice(lo, hi + 1).join(" · ")}${hi < tabs.length - 1 ? " …" : ""}`;
	const fits = (lo: number, hi: number): boolean => visibleWidth(render(lo, hi)) <= max;
	let lo = at;
	let hi = at;
	while (true) {
		if (hi + 1 < tabs.length && fits(lo, hi + 1)) hi += 1;
		else if (lo - 1 >= 0 && fits(lo - 1, hi)) lo -= 1;
		else break;
	}
	const out = render(lo, hi);
	if (visibleWidth(out) <= max) return out;
	return `[${cutToWidth(tabs[at], Math.max(4, max - 2))}]`;
};

export const sessionKeyLine = (total: number, toolTools = 0, expanded = false): string => {
	const tools = toolTools > 0 ? ` • ${TOOL_TOGGLE_KEY} = ${expanded ? "hide" : "show"} tool output (${toolTools})` : "";
	return total > 1
		? `←/→ another sub-agent (live first, then finished) • 1-9 jump to one • ↑↓ scroll • PgUp/PgDn page • g/G top/bottom • space = read chat • Esc close (the agent keeps running)${tools}`
		: `↑↓ scroll • PgUp/PgDn page • g/G top/bottom • space = read chat • Esc close (the agent keeps running)${tools}`;
};

export const toolToggleKeys = (): string[] => [TOOL_TOGGLE_KEY];

export const taskLines = (prompt: string | undefined, width: number): string[] => {
	const body = (prompt ?? "").trim();
	if (!body) return ["(the task text was not captured)"];
	const lines = body.split("\n");
	const kept = lines.slice(0, SESSION_TASK_LINES).map((l) => clip(l, Math.max(10, width)));
	if (lines.length > SESSION_TASK_LINES) kept.push(`… ${lines.length - SESSION_TASK_LINES} more line(s)`);
	return kept;
};

export const steerLines = (steers: SteerEvent[] | undefined): string[] => {
	const items = steers ?? [];
	if (!items.length) return [];
	const shown = items.slice(-SESSION_MAX_STEERS);
	return shown.map((s) => `${s.mode === "followUp" ? "↳ follow-up" : "→ steer"}: ${clip(s.message, 400)}`);
};

export interface SessionBodyOptions {
	expanded?: boolean;
}

export const sessionBody = (run: SubagentRun, logLines: string[], width: number, opts: SessionBodyOptions = {}): string[] => {
	const rule = "─".repeat(Math.max(0, Math.min(24, width - 2)));
	const out: string[] = [`▸ task — what this agent was told`, ...taskLines(run.prompt, width).map((l) => `  ${l}`)];
	const steers = steerLines(run.steers);
	if (steers.length) out.push(`▸ steered (${(run.steers ?? []).length}) — what was pushed in while it ran`, ...steers.map((l) => `  ${l}`));
	const items = parseLogItems(logLines);
	const tools = toolItemCount(items);
	const expanded = opts.expanded === true;
	out.push(`▸ session — live output${run.logPath ? "" : " (no log)"}${tools ? ` · ${tools} tool call(s) · ${toolToggleHint(expanded)}` : ""}`, rule);
	out.push(...renderLogItems(items, { expanded }));
	return out;
};

export const sessionToolCount = (logLines: string[]): number => toolItemCount(parseLogItems(logLines));

export const sessionSummaryLine = (run: SubagentRun): string => `${clip((run.prompt ?? "").replace(/\s+/g, " "), 100) || "(task text not captured)"}${run.logPath ? ` → ${run.logPath}` : ""}`;

export const sessionNoteLine = (run: SubagentRun): string =>
	run.status === "running" ? "live — output refreshes every second; closing this page never interrupts the run" : `finished · ${clip(run.summary ?? "", 160)}`;
