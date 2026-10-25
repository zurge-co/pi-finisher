import { readdirSync } from "node:fs";
import { join } from "node:path";
import { clarifyChrome, type ClarifyGap, type ClarifyQuestion } from "./goal-clarify.ts";

export const CLARIFY_CHOICE_MAX = 4;

export const CLARIFY_ANSWER_MAX = 240;

const IGNORED_ROOTS = new Set(["node_modules", ".git", ".finisher", ".pi", "dist", "build", "coverage"]);

export const CLARIFY_PICK_HINT = "enter = choose  •  esc = stop asking  •  type to filter";

export const targetChoices = (names: readonly string[], limit = CLARIFY_CHOICE_MAX): string[] => {
	const out: string[] = [];
	for (const raw of names ?? []) {
		const name = String(raw ?? "").trim();
		if (!name || name.startsWith(".") || IGNORED_ROOTS.has(name) || out.includes(name)) continue;
		out.push(name);
		if (out.length >= Math.max(1, limit)) break;
	}
	return out;
};

export const clarifyTargets = (cwd: string, limit = CLARIFY_CHOICE_MAX): string[] => {
	try {
		const entries = readdirSync(cwd, { withFileTypes: true });
		const roots = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		const moduleDir = join(cwd, "extensions", "finisher", "src");
		const modules = (() => {
			try {
				return readdirSync(moduleDir).filter((f) => f.endsWith(".ts"));
			} catch {
				return [];
			}
		})();
		return targetChoices([...modules, ...roots], limit);
	} catch {
		return [];
	}
};

export type ClarifyAsk = (question: ClarifyQuestion) => Promise<string | null | undefined>;

export interface ClarifyAsked {
	answers: Partial<Record<ClarifyGap, string>>;
	asked: number;
	stopped: boolean;
}

export const askClarify = async (ask: ClarifyAsk, questions: readonly ClarifyQuestion[], lang?: string): Promise<ClarifyAsked> => {
	const words = clarifyChrome(lang);
	const answers: Partial<Record<ClarifyGap, string>> = {};
	let asked = 0;
	for (const question of questions ?? []) {
		if (!question?.options?.length) continue;
		const picked = await ask(question);
		asked++;
		if (picked === undefined || picked === null) return { answers, asked, stopped: true };
		const text = String(picked).replace(/\s+/g, " ").trim().slice(0, CLARIFY_ANSWER_MAX);
		if (!text || text.toLowerCase() === words.asIs.toLowerCase()) continue;
		answers[question.gap] = text;
	}
	return { answers, asked, stopped: false };
};
