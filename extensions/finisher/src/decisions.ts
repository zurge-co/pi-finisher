import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";

export const DECISION_MARKER = "DECISION NEEDED:";
export const DECISIONS_FILE = "decisions.md";
export const DECISIONS_MAX = 40;

export interface AgentDecision {
	at: number;
	from: string;
	question: string;
	assumption: string;
}

export const decisionsPath = (cwd: string): string => join(finisherDir(cwd), DECISIONS_FILE);

export const parseDecisions = (from: string, output: string, at = Date.now()): AgentDecision[] => {
	const out: AgentDecision[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const at2 = line.indexOf(DECISION_MARKER);
		if (at2 < 0) continue;
		const question = line.slice(at2 + DECISION_MARKER.length).trim();
		if (!question) continue;
		const next = lines[i + 1]?.trim() ?? "";
		const assumption = /^(assumption|assumed|i assumed|decided|went with|chose)[:\s]/i.test(next) ? next.replace(/^[^:]*:\s*/, "") : "";
		out.push({ at, from, question: question.slice(0, 300), assumption: assumption.slice(0, 300) });
	}
	return out;
};

export const addDecisions = (existing: AgentDecision[], incoming: AgentDecision[], cap = DECISIONS_MAX): AgentDecision[] => {
	const seen = new Set(existing.map((d) => `${d.from}|${d.question.toLowerCase()}`));
	const merged = [...existing];
	for (const d of incoming) {
		const key = `${d.from}|${d.question.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(d);
	}
	return merged.length <= cap ? merged : merged.slice(merged.length - cap);
};

export const renderDecisions = (items: AgentDecision[]): string => {
	if (!items.length) return "";
	const lines = ["", "decisions made without asking you:"];
	for (const d of items) {
		lines.push(`  • [${d.from}] ${d.question}${d.assumption ? ` → ${d.assumption}` : ""}`);
	}
	return lines.join("\n");
};

export const writeDecisionsFile = (cwd: string, goal: string, items: AgentDecision[]): string | undefined => {
	if (!items.length) return undefined;
	try {
		mkdirSync(finisherDir(cwd), { recursive: true });
		const p = decisionsPath(cwd);
		const body = [`# decisions — ${goal.slice(0, 120)}`, "", ...items.map((d) => `- [${d.from}] ${d.question}${d.assumption ? ` → ${d.assumption}` : ""} (${new Date(d.at).toISOString()})`)].join("\n");
		appendFileSync(p, `\n${body}\n`);
		return p;
	} catch {
		return undefined;
	}
};

export const readDecisionsFile = (cwd: string): string | undefined => {
	const p = decisionsPath(cwd);
	if (!existsSync(p)) return undefined;
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
};

export const noHumanRule = (): string => [
	"You cannot ask a human anything and no picker will open for you.",
	"When a decision is genuinely yours to make, write one line `DECISION NEEDED: <the question>` followed by `assumption: <what you chose>`, then continue with that assumption.",
	"Never stop to wait for an answer — a stalled worker is a failed worker.",
].join(" ");

export const withDecisionRule = (prompt: string): string => `${prompt}\n\n${noHumanRule()}`;

export const reportWithDecisions = (report: string, items: AgentDecision[]): string => `${report}${renderDecisions(items)}`;
