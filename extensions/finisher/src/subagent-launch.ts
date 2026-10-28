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
import { recordCall, type RecordedCall } from "./evidence-record.ts";
import { stateLabel } from "./project-dir.ts";

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
		opts: { caseId?: string } = {},
	): Promise<{ ok: boolean; output: string; logPath: string; calls: RecordedCall[] }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const calls: RecordedCall[] = [];
		const argsById = new Map<string, { name?: string; args?: unknown }>();
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		rescheduleTicker(ctx);
		updateWidget(ctx);
		const runChunk = (chunk: string) => {
			run.streamTail = streamTail(chunk);
			onChunk?.(chunk);
		};
		try {
			const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const modelPattern = resolveSubagentModel(ctx.cwd, { slotModel: modelOverride, mainModel }).pattern;
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
				onTool: (tool) => {
					if (tool.phase === "start") {
						argsById.set(tool.id, { name: tool.name, args: tool.args });
						return;
					}
					const started = argsById.get(tool.id);
					argsById.delete(tool.id);
					const next = recordCall(calls, { name: tool.name ?? started?.name, args: started?.args, isError: tool.isError });
					if (next !== calls) {
						calls.length = 0;
						calls.push(...next);
					}
				},
			});
			const diagnosis = diagnoseProviderMissing(modelPattern, r0);
			const r = diagnosis && !r0.ok ? { ...r0, output: `${buildProviderMissingGuidance(role, diagnosis.patternProvider)}\n---\n${r0.output}` } : r0;
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			run.streamTail = undefined;
			if (r.usedModel) run.model = r.usedModel;
			if (modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — ladder asked for "${modelPattern}" but it actually ran "${r.usedModel}" (pi fallback? check ${stateLabel(ctx.cwd, "models.json")} / /finisher models)`, "warning");
			}
			if (r.ok && r.output.trim()) {
				const captured = parseDecisions(role, r.output);
				if (captured.length) {
					state.decisions = addDecisions(state.decisions ?? [], captured);
					run.decisions = captured.length;
				}
				run.handoffItems = handoffStackFor<never>(undefined).length;
			}
			run.calls = calls;
			return { ...r, calls };
		} catch (err) {
			run.ok = false;
			run.status = "failed";
			run.summary = err instanceof Error ? err.message : String(err);
			run.streamTail = undefined;
			return { ok: false, output: `the sub-agent never started: ${run.summary} (log: ${logPath})`, logPath, calls };
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
