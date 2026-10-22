
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { zenseDir, type Spec, type Tracker } from "./types.ts";

export const buildSpecChanges = (prev: Spec, next: Spec): string[] => {
	const lines: string[] = [];
	if (prev.title !== next.title) lines.push(`title: "${prev.title}" → "${next.title}"`);
	if (prev.intent !== next.intent) lines.push(`intent: changed (read the new text in the spec below)`);
	const listDiff = (label: string, a: string[], b: string[]) => {
		for (const x of b.filter((x) => !a.includes(x))) lines.push(`${label} +: ${x}`);
		for (const x of a.filter((x) => !b.includes(x))) lines.push(`${label} −: ${x}`);
	};
	listDiff("approach", prev.approach ?? [], next.approach ?? []);
	listDiff("scope", prev.scope ?? [], next.scope ?? []);
	listDiff("constraints", prev.constraints ?? [], next.constraints ?? []);
	const prevById = new Map((prev.criteria ?? []).map((c) => [c.id, c]));
	const nextById = new Map((next.criteria ?? []).map((c) => [c.id, c]));
	for (const [id, c] of nextById) {
		const p = prevById.get(id);
		if (!p) lines.push(`criteria +: ${id}: ${c.text} (check: ${c.check})`);
		else if (p.text !== c.text || p.check !== c.check)
			lines.push(
				`criteria ~: ${id}` +
					(p.text !== c.text ? ` text: "${p.text}" → "${c.text}"` : "") +
					(p.check !== c.check ? ` check: "${p.check}" → "${c.check}"` : ""),
			);
	}
	for (const [id, c] of prevById) if (!nextById.has(id)) lines.push(`criteria −: ${id}: ${c.text}`);
	listDiff("specDebt", prev.specDebt ?? [], next.specDebt ?? []);
	return lines.length
		? lines
		: [`⚠️ No changes from v${prev.version} — the new spec is identical to the previous version`];
};

export const CHANGE_GROUPS: ReadonlyArray<[string, (line: string) => boolean]> = [
	["Title & intent", (l) => l.startsWith("title:") || l.startsWith("intent:")],
	["Approach", (l) => l.startsWith("approach ")],
	["Scope", (l) => l.startsWith("scope ")],
	["Constraints", (l) => l.startsWith("constraints ")],
	["Criteria", (l) => l.startsWith("criteria ")],
	["Spec debt", (l) => l.startsWith("specDebt ")],
];

const bucketSpecChanges = (lines: string[]) => {
	const buckets = new Map<string, string[]>();
	const warns: string[] = [];
	const other: string[] = [];
	for (const line of lines) {
		if (line.startsWith("⚠️")) {
			warns.push(line);
			continue;
		}
		const group = CHANGE_GROUPS.find(([, match]) => match(line));
		if (group) {
			const bucket = buckets.get(group[0]) ?? [];
			bucket.push(line);
			buckets.set(group[0], bucket);
		} else other.push(line);
	}
	return { buckets, warns, other };
};

export const groupSpecChanges = (lines: string[]): string => {
	const { buckets, warns, other } = bucketSpecChanges(lines);
	const numbered = (items: string[]) => items.map((x, i) => `${i + 1}. ${x}`).join("\n");
	const parts: string[] = [];
	if (warns.length) parts.push(warns.join("\n"));
	for (const [heading] of CHANGE_GROUPS) {
		const items = buckets.get(heading);
		if (items?.length) parts.push(`### ${heading}\n${numbered(items)}`);
	}
	if (other.length) parts.push(`### Other\n${numbered(other)}`);
	return parts.join("\n\n");
};

export type ChangeMarkRole = Extract<ThemeColor, "success" | "error" | "warning">;

export const renderSpecChangesTui = (spec: Spec, color: (role: ChangeMarkRole, text: string) => string): string[] => {
	if (!spec.changesFrom?.length) return [];
	const { buckets, warns, other } = bucketSpecChanges(spec.changesFrom);
	const ROLE = { "+": "success", "−": "error", "~": "warning" } as const;
		const renderItem = (line: string, n: number): string => {
		const m = /^(\S+) ([+−~]): (.*)$/.exec(line);
		return m ? color(ROLE[m[2] as keyof typeof ROLE], `${n}. ${m[3]}`) : `${n}. ${line}`;
	};
	const groups: string[][] = [];
	if (warns.length) groups.push([...warns]); 	for (const [heading] of CHANGE_GROUPS) {
		const items = buckets.get(heading);
		if (items?.length) groups.push([`### ${heading}`, ...items.map((x, i) => renderItem(x, i + 1))]);
	}
	if (other.length) groups.push(["### Other", ...other.map((x, i) => `${i + 1}. ${x}`)]);
	return [`## Changes in v${spec.version} (vs v${spec.version - 1})`, "", ...groups.flatMap((g, i) => (i ? ["", ...g] : g))];
};

export const renderSpecMd = (s: Spec): string =>
	`# Spec v${s.version}: ${s.title}\napproved: ${s.approved}\n\n` +
	(s.changesFrom?.length
		? `## Changes in v${s.version} (vs v${s.version - 1})\n${groupSpecChanges(s.changesFrom)}\n\n`
		: "") +
	(s.crossCheck?.length ? `## Cross-check (what we understood you want)\n${s.crossCheck.map((x) => `- ${x}`).join("\n")}\n\n` : "") +
	(s.outcomes ? `## What you'll get\n${s.outcomes}\n\n` : "") +
	`## Intent\n${s.intent}\n\n${s.approach?.length ? "## Approach\n" + s.approach.map((x) => `- ${x}`).join("\n") + "\n\n" : ""}## Scope\n${s.scope.map((x) => `- ${x}`).join("\n")}\n\n## Constraints\n${s.constraints.map((x) => `- ${x}`).join("\n")}\n\n## Acceptance criteria\n${s.criteria.map((c) => `- [ ] ${c.id}: ${c.text} *(check: ${c.check})*`).join("\n")}\n\n## Spec debt (human-verified only)\n${s.specDebt.map((x) => `- ${x}`).join("\n")}\n`;

export const goalLines = (s: { crossCheck?: string[]; outcomes?: string; intent?: string }): string[] => {
	const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);
	if (s.crossCheck?.length) {
		const lines = clean(s.crossCheck);
		if (lines.length) return lines;
	}
	if (s.outcomes?.trim()) {
		const lines = clean(s.outcomes.split("\n"));
		if (lines.length) return lines;
	}
	return clean((s.intent ?? "").split("\n")).slice(0, 8);
};

export const sameGoalLines = (
	a: { crossCheck?: string[]; outcomes?: string; intent?: string },
	b: { crossCheck?: string[]; outcomes?: string; intent?: string },
): boolean => {
	const norm = (line: string): string => line.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
	const pack = (s: typeof a): string[] => [...new Set(goalLines(s).map(norm).filter(Boolean))].sort();
	const A = pack(a);
	const B = pack(b);
	return A.length > 0 && A.length === B.length && A.every((x, i) => x === B[i]);
};

export type SpecApprovalDecision =
	| { kind: "auto"; reason: "tracker" | "gate-off" | "goals-unchanged" }
	| { kind: "ask"; mode: "tui" | "select" }
	| { kind: "unsigned"; reason: "no-ui" };

export const decideSpecApproval = (opts: {
	signMode?: "ask" | "auto";
	gateEnabled: boolean;
	goalsUnchanged: boolean;
	hasUI: boolean;
	tui: boolean;
}): SpecApprovalDecision => {
	if (opts.signMode === "auto") return { kind: "auto", reason: "tracker" };
	if (!opts.gateEnabled) return { kind: "auto", reason: "gate-off" };
	if (opts.goalsUnchanged) return { kind: "auto", reason: "goals-unchanged" };
	if (opts.hasUI && opts.tui) return { kind: "ask", mode: "tui" };
	if (opts.hasUI) return { kind: "ask", mode: "select" };
	return { kind: "unsigned", reason: "no-ui" };
};

export const rejectionDirective = (kind: "spec" | "tracker" | "review" | "gate", reason: string, version?: number): string => {
	const why = reason.trim() || "(no reason given)";
	const v = version !== undefined ? ` v${version}` : "";
	if (kind === "spec")
		return `The human did NOT sign spec${v}. Their reason: "${why}"\nRevise the spec (cross-check cases, scope or approach) to match this correction, then call zense_spec again — do not implement until it is signed.`;
	if (kind === "tracker")
		return `The human did NOT sign the longrun tracker${v}. Their reason: "${why}"\nAmend specs.md / the phase plan to match this correction, then call zense_longrun plan again — do not start phases.`;
	if (kind === "review")
		return `The human REJECTED the review. Their reason: "${why}"\nDo not treat the work as accepted: fix it or re-spec, then eval/review again. The staged change was left untouched (nothing discarded).`;
	return `The human did not sign — this write is blocked. Their reason: "${why}"\nRevise the spec to match this correction, then ask for the signature again.`;
};

export const renderSignOutcome = (s: Spec): string => {
	const goals = goalLines(s);
	const body = goals.length
		? goals.map((g) => `- ${g}`).join("\n")
		: "- (the requirements agent did not summarize this — see the technical spec file)";
	return (
		`## Cross-check — what we understood you want\n\n${body}\n\n` +
		`> Full technical spec (approach, scope, checks, constraints, spec debt): \`.zense/spec.md\``
	);
};

export const renderTrackerOutcomes = (t: Tracker): string => {
	const setGoals = goalLines(t);
	const setBody = setGoals.length ? setGoals.map((g) => `- ${g}`).join("\n") : "- (no summary yet)";
	const phaseLines = t.phases
		.map((p) => {
			const pg = goalLines(p);
			const body = pg.length ? pg.map((g) => `  - ${g}`).join("\n") : "  - (no summary yet)";
			return `- **${p.id} “${p.title}”**\n${body}`;
		})
		.join("\n");
	return (
		`## Cross-check — what we understood you want\n\n${setBody}\n\n### By phase\n\n${phaseLines}\n\n` +
		`> Full technical plan (scope, checks, constraints per phase): \`.zense/long-running/${t.slug}/tracker.md\``
	);
};

export const syncApprovedSpecFiles = (cwd: string, spec: Spec, paths?: { json?: string; md?: string }): boolean => {
	const json = JSON.stringify(spec, null, 2);
	const md = renderSpecMd(spec);
	const targets: Array<[string | undefined, string]> = [
		[join(zenseDir(cwd), "spec.json"), json],
		[join(zenseDir(cwd), "spec.md"), md],
		[paths?.json, json],
		[paths?.md, md],
	];
	let wroteAny = false;
	for (const [p, content] of targets) {
		try {
			if (!p || !existsSync(p)) continue;
			writeFileSync(p, content);
			wroteAny = true;
		} catch {
		}
	}
	return wroteAny;
};

export const applyFullscreenDefault = (raw: string | undefined): { text: string; changed: boolean } | null => {
	if (raw === undefined || !raw.trim()) return { text: `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	if ("tuiMode" in (parsed as Record<string, unknown>)) return { text: raw, changed: false };
	return { text: `${JSON.stringify({ ...(parsed as Record<string, unknown>), tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
};
