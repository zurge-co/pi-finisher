import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildFileReviewReport, commandWritePaths, reviewWrittenFile, scriptWrites, stdinTargets, type FileReview } from "./review-file.ts";
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

	const suiteRefusalFor = (ev: any, ctx: ExtensionContext): string | undefined => {
		if (ev.toolName !== "write" && ev.toolName !== "edit") return undefined;
		const path = (ev.input as { path?: string })?.path;
		if (typeof path !== "string" || !path) return undefined;
		const abs = resolve(ctx.cwd, path);
		return suiteWriteGate(state.suiteAtStart, ctx.cwd, relative(ctx.cwd, abs) || abs, existsSync(abs));
	};

	const applyHygieneCheck = (ev: any, ctx: ExtensionContext): { content?: any[]; isError?: boolean } | undefined => {
		if (ev.toolName !== "write" && ev.toolName !== "edit" && ev.toolName !== "bash") return undefined;
		const bad: FileReview[] = [];
		for (const target of [...new Set(targetsFor(ev))]) {
			const abs = resolve(ctx.cwd, target);
			let text: string;
			try {
				text = readFileSync(abs, "utf8");
			} catch {
				continue;
			}
			const review = reviewWrittenFile(relative(ctx.cwd, abs) || abs, text);
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
