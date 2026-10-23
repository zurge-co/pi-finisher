import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { zenseDir } from "./types.ts";

export const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(zenseDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};
