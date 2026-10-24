import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_EXCLUDE_TOOLS, SUBAGENT_STRIP_FLAGS, subagentTimeout, buildRpcSubagentArgs, diagnoseProviderMissing, buildProviderMissingGuidance, modelMatchesPattern } from "./subagent-config.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { addDecisions, parseDecisions, withDecisionRule } from "./decisions.ts";
import { streamTail } from "./agent-panel.ts";
import { resolveSubagentModel } from "./models.ts";
import { type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { handoffInjectionFor, handoffStackFor } from "./handoff-gate.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createSubagentLaunch = (ctx: HarnessContext) => {
	const state = ctx.state;
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
		const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const modelPattern = resolveSubagentModel(ctx.cwd, { slotModel: modelOverride, mainModel }).pattern;
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
			const injected = handoffInjectionFor(undefined);
			const prompt = withDecisionRule(injected ? `${task}\n\n${injected}` : task);
			run.prompt = prompt;
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
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — ladder asked for "${modelPattern}" but it actually ran "${r.usedModel}" (pi fallback? check .finisher/models.json / /finisher models)`, "warning");
			}
			if (r.ok && r.output.trim()) {
				const captured = parseDecisions(role, r.output);
				if (captured.length) {
					state.decisions = addDecisions(state.decisions ?? [], captured);
					run.decisions = captured.length;
				}
				run.handoffItems = handoffStackFor<never>(undefined).length;
			}
			return r;
		} finally {
			rescheduleTicker(ctx);
			persist();
			updateWidget(ctx);
		}
	};

	const isClassifierModel = (ctx: ExtensionContext, provider: string, id: string): boolean => {
		try {
			const reg = ctx.modelRegistry as unknown as { getModelOfType?: (t: string, p: string, i: string) => unknown };
			return !!reg.getModelOfType?.("classifier", provider, id);
		} catch {
			return false;
		}
	};

	return { launchSubagent, isClassifierModel };
};
