import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir } from "./types.ts";

export const HANDOFF_KEY = "handoff";

export interface HandoffModel {
	pattern: string;
	provider: string;
	id: string;
	source: "models.json" | "config.json";
}

export const splitHandoffPattern = (pattern: string): { provider: string; id: string } | undefined => {
	const clean = pattern.trim();
	const slash = clean.indexOf("/");
	if (slash <= 0 || slash === clean.length - 1) return undefined;
	return { provider: clean.slice(0, slash), id: clean.slice(slash + 1) };
};

const readKey = (file: string, key: string): string | undefined => {
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const v = raw[key];
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	} catch {
		return undefined;
	}
};

export const readHandoffModel = (cwd: string): HandoffModel | undefined => {
	for (const [file, source] of [
		[join(zenseDir(cwd), "models.json"), "models.json"],
		[join(zenseDir(cwd), "config.json"), "config.json"],
	] as const) {
		const pattern = readKey(file, HANDOFF_KEY);
		if (!pattern) continue;
		const parts = splitHandoffPattern(pattern);
		if (!parts) continue;
		return { pattern, provider: parts.provider, id: parts.id, source };
	}
	return undefined;
};

export const withoutHandoffKey = (keys: string[]): string[] => keys.filter((k) => k !== HANDOFF_KEY);

export const HANDOFF_ASK_PROMPT = (from: string, text: string): string =>
	[
		`You are deciding what a later task must not have to rediscover.`,
		`Answer with exactly one word on the first line — KEEP or DROP — then at most one short line of reason.`,
		`KEEP only if it is a fact, decision, or constraint that would make the next task faster or more correct.`,
		`DROP statistics, counts, file lists, restatements of code, and anything obvious from the repo.`,
		``,
		`From: ${from}`,
		`Candidate:`,
		text.slice(0, 4_000),
	].join("\n");

export const parseHandoffVerdict = (out: string): { keep: boolean; reason: string } | undefined => {
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	const head = lines[0]?.toUpperCase() ?? "";
	if (head.startsWith("KEEP")) return { keep: true, reason: lines[1] ?? "" };
	if (head.startsWith("DROP")) return { keep: false, reason: lines[1] ?? "" };
	return undefined;
};

export const handoffAskLine = (from: string, keep: boolean): string =>
	`handoff: ${keep ? "kept" : "dropped"} a ${from} note (chat model verdict)`;

export type HandoffRoute =
	| { kind: "classifier"; provider: string; id: string }
	| { kind: "chat"; provider: string; id: string }
	| { kind: "none"; why: "unset" | "unresolvable" };

export const routeHandoffModel = (
	model: HandoffModel | undefined,
	isClassifier: (provider: string, id: string) => boolean,
): HandoffRoute => {
	if (!model) return { kind: "none", why: "unset" };
	if (isClassifier(model.provider, model.id)) return { kind: "classifier", provider: model.provider, id: model.id };
	return { kind: "chat", provider: model.provider, id: model.id };
};

export const handoffRouteNote = (r: HandoffRoute): string => {
	if (r.kind === "classifier") return `handoff: using classifier ${r.provider}/${r.id} from the ladder`;
	if (r.kind === "chat") return `handoff: using chat model ${r.provider}/${r.id} from the ladder (asked KEEP/DROP)`;
	return r.why === "unset" ? "handoff: no model configured in the ladder — falling back to any available pi classifier" : "handoff: the configured model does not resolve";
};
