import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_EXCLUDE_TOOLS, SUBAGENT_STRIP_FLAGS, subagentTimeout, buildRpcSubagentArgs, diagnoseProviderMissing, buildProviderMissingGuidance, modelMatchesPattern } from "./subagent-config.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { appendHandoff, handoffInjection, readHandoff } from "./handoff-stack.ts";
import { decideKeep, describeDecision, classifyGateway, needsClassifierSetup, classifierGuidance } from "./handoff-classify.ts";
import { streamTail } from "./agent-panel.ts";
import { resolveModelPattern } from "./models.ts";
import { type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createSubagentLaunch = (ctx: HarnessContext) => {
	const state = ctx.state;
	const classifierWarned = new Map<string, boolean>();
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;
	const rescheduleTicker = ctx.rescheduleTicker;

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
			const stripFlags = SUBAGENT_STRIP_FLAGS[role] ?? [];
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
			const r = diagnosis && !r0.ok ? { ...r0, output: `${buildProviderMissingGuidance(role, diagnosis.patternProvider)}\n---\n${r0.output}` } : r0;
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			run.streamTail = undefined;
			if (r.usedModel) run.model = r.usedModel;
			if (modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config asked for "${modelPattern}" but actually ran "${r.usedModel}" (pi fallback? check .zense/models.json / /zense models)`, "warning");
			}
			if (r.ok && r.output.trim()) {
				const decision = await decideKeep(classifyGateway(ctx.modelRegistry), { from: role, text: r.output.slice(-4_000) });
				if (needsClassifierSetup(decision)) {
					const seen = classifierWarned.get(role);
					if (!seen) {
						classifierWarned.set(role, true);
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

	return { launchSubagent };
};
