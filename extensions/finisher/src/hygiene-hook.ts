import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HYGIENE_MAX_BYTES, isHygieneChecked } from "./code-hygiene.ts";
import { buildFileReviewReport, commandWritePaths, oversizeFileReview, reviewWrittenFile, scriptWrites, stdinTargets, type FileReview } from "./review-file.ts";
import { suiteWriteGate } from "./suite-budget.ts";
import { type Persist, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State } from "./types.ts";

export const createHygieneHook = (ctx: HarnessContext) => {
	const state = ctx.state;
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;

	const targetsFor = (ev: any): string[] => {
		if (ev.toolName === "bash") {
			const cmd = (ev.input as { command?: string })?.command;
			if (typeof cmd !== "string" || !cmd) return [];
			return [...commandWritePaths(cmd), ...(scriptWrites(cmd) ? stdinTargets(cmd) : [])];
		}
		const path = (ev.input as { path?: string })?.path;
		return typeof path === "string" && path ? [path] : [];
	};

	const SUITE_WRITE_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

	const suiteRefusalFor = (ev: any, ctx: ExtensionContext): string | undefined => {
		if (!SUITE_WRITE_TOOLS.has(String(ev.toolName ?? "").trim().toLowerCase())) return undefined;
		for (const target of new Set(targetsFor(ev))) {
			const abs = resolve(ctx.cwd, target);
			const refusal = suiteWriteGate(state.suiteAtStart, ctx.cwd, relative(ctx.cwd, abs) || abs, existsSync(abs));
			if (refusal) return refusal;
		}
		return undefined;
	};

	const applyHygieneCheck = (ev: any, ctx: ExtensionContext): { content?: any[]; isError?: boolean } | undefined => {
		if (ev.toolName !== "write" && ev.toolName !== "edit" && ev.toolName !== "bash") return undefined;
		const bad: FileReview[] = [];
		for (const target of [...new Set(targetsFor(ev))]) {
			const abs = resolve(ctx.cwd, target);
			const rel = relative(ctx.cwd, abs) || abs;
			if (!isHygieneChecked(rel)) continue;
			let bytes: number;
			try {
				bytes = statSync(abs).size;
			} catch {
				continue;
			}
			if (bytes > HYGIENE_MAX_BYTES) {
				bad.push(oversizeFileReview(rel, bytes));
				continue;
			}
			let text: string;
			try {
				text = readFileSync(abs, "utf8");
			} catch {
				continue;
			}
			const review = reviewWrittenFile(rel, text);
			if (!review.ok) bad.push(review);
		}
		if (!bad.length) {
			if (state.hygieneViolations) {
				state.hygieneViolations = undefined;
				persist();
				updateWidget(ctx);
			}
			return undefined;
		}
		state.hygieneViolations = bad.flatMap((r) => r.violations);
		persist();
		updateWidget(ctx);
		const content = Array.isArray(ev.content) ? [...ev.content] : [];
		content.push({ type: "text", text: `\n⚠ ${bad.map(buildFileReviewReport).join("\n\n")}` });
		return { content, isError: true };
	};

	const blockedBySuiteBudget = (ev: any, ctx: ExtensionContext): { block: true; reason: string } | undefined => {
		const reason = suiteRefusalFor(ev, ctx);
		return reason ? { block: true, reason } : undefined;
	};

	pi.on("tool_call", async (ev, ctx) => blockedBySuiteBudget(ev, ctx));
	pi.on("tool_result", async (ev, ctx) => applyHygieneCheck(ev, ctx));

	return { applyHygieneCheck, blockedBySuiteBudget, suiteRefusalFor };
};
