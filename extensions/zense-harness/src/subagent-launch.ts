import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_EXCLUDE_TOOLS, subagentStripFlagsAsync, subagentTimeout, buildRpcSubagentArgs, diagnoseProviderMissing, buildProviderMissingGuidance, findProviderExtension, mergeExtInclude, modelMatchesPattern, writeSubagentExtIncludes, subagentExtIncludes, listInstalledExtensions } from "./subagent-config.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { appendHandoff, handoffInjection, readHandoff } from "./handoff-stack.ts";
import { decideKeep, describeDecision, classifyGateway, needsClassifierSetup, classifierGuidance } from "./handoff-classify.ts";
import { streamTail } from "./agent-panel.ts";
import { resolveModelPattern } from "./models.ts";
import { type Learn, type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createSubagentLaunch = (ctx: HarnessContext) => {
	const state = ctx.state;
	const classifierWarned = new Map<string, boolean>();
	const learn = ctx.learn;
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;
	const rescheduleTicker = ctx.rescheduleTicker;

	const healProviderMismatch = async (
		ctx: ExtensionContext,
		role: string,
		modelPattern: string,
		r0: { ok: boolean; output: string; logPath: string; usedModel?: string },
		subCwd: string,
		stripFlags: string[],
		task: string,
		onChunk: ((chunk: string) => void) | undefined,
		run: SubagentRun,
		patternProvider: string,
	): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> => {
		const include = subagentExtIncludes(role, subCwd, ctx.cwd);
		const hit = findProviderExtension(patternProvider, await listInstalledExtensions(subCwd));
		const alreadyIncluded = hit ? include.includes(hit.path) : false;
		if (hit && !alreadyIncluded) {
			ctx.ui.notify(`🔁 zense: provider "${patternProvider}" is unavailable in the sub-agent (${role}) — retrying with extension '${hit.label}' loaded`, "info");
			run.retried = true;
			const r2 = await runRpcSubagent({ role, cwd: subCwd, prompt: task, logPath: r0.logPath, timeoutMs: subagentTimeout(role, subCwd, ctx.cwd), cliArgs: [...buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS[role], role, stripFlags), "-e", hit.path], model: modelPattern, onChunk });
			if (r2.ok && r2.usedModel && modelMatchesPattern(r2.usedModel, modelPattern)) {
				const merged = mergeExtInclude(include, hit.path);
				if (merged !== include) writeSubagentExtIncludes(ctx.cwd, role, merged);
				run.autoIncluded = true;
				learn(ctx, `provider auto-heal: ${role} — auto-included '${hit.label}' for provider "${patternProvider}" (merged + persisted into .zense/config.json)`);
				ctx.ui.notify(`✅ zense: auto-included '${hit.label}' for role ${role} (provider "${patternProvider}") — undo with /zense ext-config-show ${role} off ${hit.path}`, "info");
				return r2;
			}
			learn(ctx, `provider auto-heal failed: ${role} — still broken with '${hit.label}' included (ok=${r2.ok} used=${r2.usedModel ?? "?"} wanted ${modelPattern})`);
			return { ...r2, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, autoRetried: true })}\n---\n${r2.output}` };
		}
		learn(ctx, `provider missing: ${role} needs "${patternProvider}" but can't heal — ${hit ? (alreadyIncluded ? "extension already included, still falling back (suspect auth)" : "extension ambiguous/unusable") : "no provider extension found"}`);
		return { ...r0, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, alreadyIncluded })}\n---\n${r0.output}` };
	};

	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
		signal?: AbortSignal,
		modelOverride?: string,
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const modelPattern = modelOverride ?? resolveModelPattern(ctx.cwd, role, mainModel);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		rescheduleTicker(ctx);
		updateWidget(ctx);
		const runChunk = (chunk: string) => {
			run.streamTail = streamTail(chunk);
			onChunk?.(chunk);
		};
		try {
			const subCwd = ctx.cwd;
			const stripFlags = await subagentStripFlagsAsync(role, subCwd, ctx.cwd);
			const handoff = handoffInjection(readHandoff(ctx.cwd));
			const prompt = handoff ? `${task}\n\n${handoff}` : task;
			const r0 = await runRpcSubagent({
				role,
				cwd: subCwd,
				prompt,
				logPath,
				timeoutMs: subagentTimeout(role, subCwd, ctx.cwd),
				cliArgs: buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS[role], role, stripFlags),
				model: modelPattern,
				onChunk: runChunk,
				signal,
			});
			const diagnosis = diagnoseProviderMissing(modelPattern, r0);
			let r = r0;
			let healHandled = false;
			if (diagnosis && !signal?.aborted) {
				healHandled = true;
				r = await healProviderMismatch(ctx, role, modelPattern!, r0, subCwd, stripFlags, task, onChunk, run, diagnosis.patternProvider);
			}
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			run.streamTail = undefined;
			if (r.usedModel) run.model = r.usedModel;
			if (!healHandled && modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				learn(ctx, `sub-agent model mismatch: ${role} requested ${modelPattern} but ran ${r.usedModel}`);
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config asked for "${modelPattern}" but actually ran "${r.usedModel}" (pi fallback? check .zense/models.json / /zense models)`, "warning");
			}
			if (!r.ok) learn(ctx, `sub-agent failed: ${role} — ${r.output.split("\n")[0].slice(0, 160)}`);
			if (r.ok && r.output.trim()) {
				const decision = await decideKeep(classifyGateway(ctx.modelRegistry), { from: role, text: r.output.slice(-4_000) });
				learn(ctx, describeDecision(decision, role));
				if (needsClassifierSetup(decision)) {
					const seen = classifierWarned.get(role);
					if (!seen) {
						classifierWarned.set(role, true);
						learn(ctx, `handoff disabled for ${role}: ${classifierGuidance()}`);
						if (ctx.hasUI) ctx.ui.notify(`⚠ zense handoff: ${classifierGuidance()}`, "warning");
					}
				}
				if (decision.keep) {
					const next = appendHandoff(ctx.cwd, { at: Date.now(), from: role, text: r.output.slice(-4_000) });
					run.handoffItems = next.length;
				}
			}
			return r;
		} finally {
			rescheduleTicker(ctx);
			persist();
			updateWidget(ctx);
		}
	};

	return { healProviderMismatch, launchSubagent };
};
