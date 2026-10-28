import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";

export const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(finisherDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};

export const LOG_TAIL_BYTES = 256 * 1024;
export const LOG_TAIL_LINES = 400;

const clampInt = (value: number | undefined, fallback: number, floor: number): number =>
	Number.isFinite(value) ? Math.max(floor, Math.floor(value as number)) : fallback;

export const tailWindow = (size: number, maxBytes = LOG_TAIL_BYTES): { from: number; length: number } => {
	const total = Math.max(0, Math.floor(Number.isFinite(size) ? size : 0));
	const window = Math.min(total, clampInt(maxBytes, LOG_TAIL_BYTES, 1));
	return { from: total - window, length: window };
};

export const tailLinesOf = (text: string, maxLines = LOG_TAIL_LINES, cutHead = false): string[] => {
	const body = String(text ?? "");
	const lines = body.split("\n");
	const bounded = lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);
	return cutHead && bounded.length ? bounded.slice(1) : bounded;
};

const readWindow = (path: string, maxBytes: number): { text: string; cutHead: boolean } | undefined => {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const { from, length } = tailWindow(statSync(path).size, maxBytes);
		const buf = Buffer.alloc(length);
		const read = length > 0 ? readSync(fd, buf, 0, length, from) : 0;
		return { text: buf.subarray(0, read).toString("utf8"), cutHead: from > 0 };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
			}
		}
	}
};

export interface TailOptions {
	maxBytes?: number;
	maxLines?: number;
}

export const readTailLines = (path: string | undefined, opts: TailOptions = {}): string[] | undefined => {
	if (!path) return undefined;
	const window = readWindow(path, clampInt(opts.maxBytes, LOG_TAIL_BYTES, 1));
	if (!window) return undefined;
	return tailLinesOf(window.text, clampInt(opts.maxLines, LOG_TAIL_LINES, 1), window.cutHead);
};
