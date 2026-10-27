export interface PanelRun {
	role: string;
	status?: "running" | "done" | "failed";
	startedAt?: number;
	at: number;
	summary?: string;
	logPath?: string;
	model?: string;
	slotId?: string;
	streamTail?: string;
	prompt?: string;
	steers?: { at: number; mode: "steer" | "followUp"; message: string }[];
}

export interface PanelRow {
	tag: string;
	role: string;
	slot?: string;
	model?: string;
	state: string;
	elapsed?: string;
	tail?: string;
}

export interface PanelOptions {
	width?: number;
	maxTail?: number;
	finishedKeep?: number;
	showFinished?: boolean;
	now?: number;
}

const ROLE_WIDTH = 18;

const ROLE_TAG: Record<string, string> = { coder: "CODER", swarm: "CODER" };

const ROLE_LABEL: Record<string, string> = { coder: "coder", swarm: "coder" };

const roleKey = (role: string): string => String(role ?? "").trim().toLowerCase();

export const roleTag = (role: string): string => ROLE_TAG[roleKey(role)] ?? String(role ?? "").slice(0, 3).toUpperCase();

export const roleLabel = (role: string): string => ROLE_LABEL[roleKey(role)] ?? String(role ?? "");

export const elapsedLabel = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

export const clip = (s: string, max: number): string => {
	const flat = s.replace(/\s+/g, " ").trim();
	if (max <= 0) return "";
	return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
};

export const liveRuns = (runs: PanelRun[]): PanelRun[] => runs.filter((r) => r.status === "running");

export interface PanelEntry {
	row: PanelRow;
	index: number;
}

export const panelRowEntries = (runs: PanelRun[], opts: PanelOptions = {}): PanelEntry[] => {
	const now = opts.now ?? Date.now();
	const finishedKeep = opts.finishedKeep ?? 3;
	const indexed = runs.map((run, index) => ({ run, index }));
	const live = indexed.filter((e) => e.run.status === "running");
	const finished = indexed.filter((e) => e.run.status !== "running").slice(-finishedKeep);
	const merged = [...live, ...(opts.showFinished === false ? [] : finished)];
	const seen = new Map<string, number>();
	return merged.map(({ run: r, index }) => {
		const key = `${r.role}:${r.model ?? ""}`;
		const n = (seen.get(key) ?? 0) + 1;
		seen.set(key, n);
		const tag = `${roleTag(r.role)}${n > 1 ? n : ""}`;
		const liveRow = r.status === "running";
		return {
			index,
			row: {
				tag,
				role: r.role,
				...(r.slotId ? { slot: r.slotId } : {}),
				...(r.model ? { model: r.model } : {}),
				state: liveRow ? "▶" : r.status === "done" ? "✓" : "✗",
				...(liveRow ? { elapsed: elapsedLabel(now - (r.startedAt ?? r.at)) } : r.summary ? { tail: clip(r.summary, opts.maxTail ?? 40) } : {}),
				...(liveRow && r.streamTail ? { tail: clip(r.streamTail, opts.maxTail ?? 40) } : {}),
			},
		};
	});
};

export const panelRows = (runs: PanelRun[], opts: PanelOptions = {}): PanelRow[] => panelRowEntries(runs, opts).map((e) => e.row);

export const formatPanelRow = (row: PanelRow, width = 100, maxTail = 40): string => {
	const head = `${row.tag.padEnd(5)} ${row.state} ${roleLabel(row.role).padEnd(ROLE_WIDTH).slice(0, ROLE_WIDTH)}`;
	const meta = [row.slot, row.model, row.elapsed].filter(Boolean).join(" ") || "";
	const room = Math.max(0, width - head.length - meta.length - 3);
	const tail = row.tail ? clip(row.tail, Math.min(maxTail, room)) : "";
	return [head.trimEnd(), meta, tail].filter(Boolean).join(" ");
};

export const panelLines = (runs: PanelRun[], opts: PanelOptions = {}): string[] => {
	const rows = panelRows(runs, opts);
	if (!rows.length) return [];
	const liveCount = liveRuns(runs).length;
	const head = `AGENTS ▸ ${liveCount} running${rows.length > liveCount ? ` · ${rows.length - liveCount} recent` : ""}`;
	return [head, ...rows.map((r) => formatPanelRow(r, opts.width ?? 100, opts.maxTail ?? 40))];
};

export const panelTickMs = (liveCount: number): number => (liveCount > 1 ? 1_000 : 2_000);

export const streamTail = (text: string, max = 160): string => clip(text.slice(-max), max);
