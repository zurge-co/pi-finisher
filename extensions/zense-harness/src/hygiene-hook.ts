import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatHygieneViolations, isHygieneChecked, scanSource } from "./code-hygiene.ts";
import { type Learn, type Persist, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State } from "./types.ts";

export const createHygieneHook = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;

	const applyHygieneCheck = (ev: any, ctx: ExtensionContext): { content?: any[]; isError?: boolean } | undefined => {
		const name = ev.toolName;
		if (name !== "write" && name !== "edit") return undefined;
		const path = (ev.input as { path?: string })?.path;
		if (typeof path !== "string" || !path) return undefined;
		const abs = resolve(ctx.cwd, path);
		if (state.worktree && abs.startsWith(resolve(state.worktree.root))) return undefined;
		if (!isHygieneChecked(abs)) return undefined;
		let text: string;
		try {
			text = readFileSync(abs, "utf8");
		} catch {
			return undefined;
		}
		const scan = scanSource(text, relative(ctx.cwd, abs) || abs);
		if (!scan.violations.length) {
			if (state.hygieneViolations) {
				state.hygieneViolations = undefined;
				persist();
				updateWidget(ctx);
			}
			return undefined;
		}
		state.hygieneViolations = scan.violations;
		const report = formatHygieneViolations(scan.violations);
		learn(ctx, `code-hygiene: ${scan.violations.length} violation(s) in ${relative(ctx.cwd, abs)}`);
		persist();
		updateWidget(ctx);
		const content = Array.isArray(ev.content) ? [...ev.content] : [];
		content.push({ type: "text", text: `\n⚠ code-hygiene: ${report}\nfix the file you just wrote (the harness re-checks every write/edit — no human will ok it for you)` });
		return { content, isError: true };
	};

	pi.on("tool_result", async (ev, ctx) => applyHygieneCheck(ev, ctx));

	return { applyHygieneCheck };
};
