import { clip } from "./agent-panel.ts";

export const TOOL_PREFIX = "\u0000fin-tool:";
export const TOOL_HEAD_MAX = 110;
export const TOOL_OUTPUT_MAX_LINES = 40;
export const TOOL_OUTPUT_WIDE = 400;

export type ToolPhase = "start" | "end";

export interface ToolEvent {
	phase: ToolPhase;
	id: string;
	name: string;
	args?: unknown;
	output?: string;
	isError?: boolean;
	durationMs?: number;
}

export interface ToolBlock {
	id: string;
	name: string;
	target?: string;
	state: "running" | "ok" | "error";
	durationMs?: number;
	output?: string;
}

export type LogItem = { kind: "text"; line: string } | { kind: "tool"; block: ToolBlock };

const firstString = (args: unknown): string | undefined => {
	if (typeof args === "string") return args;
	if (!args || typeof args !== "object") return undefined;
	for (const v of Object.values(args as Record<string, unknown>)) if (typeof v === "string" && v.trim()) return v;
	return undefined;
};

export const toolTarget = (name: string, args: unknown): string | undefined => {
	const box = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const pick = (key: string): string | undefined => (typeof box[key] === "string" && (box[key] as string).trim() ? (box[key] as string).trim() : undefined);
	if (name === "bash") return pick("command") ?? pick("cmd");
	const path = pick("path") ?? pick("file_path") ?? pick("filePath") ?? pick("pattern") ?? pick("query");
	if (path) return path;
	return firstString(args);
};

export const flattenTarget = (target: string | undefined): string | undefined => (target ? target.replace(/\s+/g, " ").trim() || undefined : undefined);

export const toolHeadline = (block: Pick<ToolBlock, "name" | "target" | "state" | "durationMs">, max = TOOL_HEAD_MAX): string => {
	const mark = block.state === "running" ? "⚙" : block.state === "error" ? "✗" : "✓";
	const took = typeof block.durationMs === "number" ? ` ${block.durationMs < 1000 ? `${block.durationMs}ms` : `${(block.durationMs / 1000).toFixed(1)}s`}` : "";
	const target = flattenTarget(block.target);
	const head = target ? `${mark} ${block.name} — ${target}` : `${mark} ${block.name}`;
	return clip(`${head}${took}`, max);
};

export const encodeToolEvent = (ev: ToolEvent): string => `${TOOL_PREFIX}${JSON.stringify(ev)}`;

export const decodeToolEvent = (line: string): ToolEvent | undefined => {
	if (!line.startsWith(TOOL_PREFIX)) return undefined;
	try {
		const raw = JSON.parse(line.slice(TOOL_PREFIX.length)) as ToolEvent;
		if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return undefined;
		if (raw.phase !== "start" && raw.phase !== "end") return undefined;
		return raw;
	} catch {
		return undefined;
	}
};

export const isToolLogLine = (line: string): boolean => line.startsWith(TOOL_PREFIX);

export const parseLogItems = (lines: string[]): LogItem[] => {
	const items: LogItem[] = [];
	const open = new Map<string, number>();
	for (const line of lines) {
		const ev = decodeToolEvent(line);
		if (!ev) {
			items.push({ kind: "text", line });
			continue;
		}
		if (ev.phase === "start") {
			items.push({ kind: "tool", block: { id: ev.id, name: ev.name, state: "running", ...(flattenTarget(toolTarget(ev.name, ev.args)) ? { target: flattenTarget(toolTarget(ev.name, ev.args)) as string } : {}) } });
			open.set(ev.id, items.length - 1);
			continue;
		}
		const at = open.get(ev.id);
		if (at === undefined) {
			items.push({ kind: "tool", block: { id: ev.id, name: ev.name, state: ev.isError ? "error" : "ok", ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}), ...(ev.output ? { output: ev.output } : {}) } });
			continue;
		}
		const prev = items[at];
		if (prev?.kind === "tool")
			prev.block = {
				...prev.block,
				state: ev.isError ? "error" : "ok",
				...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
				...(ev.output ? { output: ev.output } : {}),
			};
		open.delete(ev.id);
	}
	return items;
};

export const outputLines = (output: string | undefined, max = TOOL_OUTPUT_MAX_LINES): string[] => {
	if (!output) return [];
	const lines = output.replace(/\r/g, "").split("\n");
	const kept = lines.slice(-max).map((l) => (l.length > TOOL_OUTPUT_WIDE ? clip(l, TOOL_OUTPUT_WIDE) : l));
	const hidden = lines.length - kept.length;
	return hidden > 0 ? [`… ${hidden} earlier line(s) hidden`, ...kept] : kept;
};

export const toolItemCount = (items: LogItem[]): number => items.filter((i) => i.kind === "tool").length;

export const renderLogItems = (items: LogItem[], opts: { expanded: boolean; maxOutputLines?: number }): string[] => {
	const out: string[] = [];
	for (const item of items) {
		if (item.kind === "text") {
			out.push(item.line);
			continue;
		}
		const block = item.block;
		const hidden = block.state === "running" ? 0 : outputLines(block.output, opts.maxOutputLines).length;
		out.push(toolHeadline(block));
		if (!opts.expanded) {
			if (hidden > 0) out.push(`    ▸ ${hidden} line(s) of output hidden — press t to show`);
			continue;
		}
		for (const line of outputLines(block.output, opts.maxOutputLines)) out.push(`    ${line}`);
		if (block.state === "running") out.push("    ▸ still running — output appears here as it arrives");
	}
	return out;
};

export const TOOL_TOGGLE_KEY = "t";

export const toolToggleHint = (expanded: boolean): string => (expanded ? "t = hide tool output" : "t = show tool output");
