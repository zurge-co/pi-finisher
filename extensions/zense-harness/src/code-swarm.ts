import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatHygieneViolations, isHygieneChecked, scanSource, type HygieneViolation } from "./code-hygiene.ts";
import { costCeilingKeysPresent } from "./goal-run.ts";
import { type LaunchSubagent, type Learn, type HarnessContext } from "./kit.ts";
import { buildCodeWorkerPrompt, mergeReport, parseWorkerFiles, planMerge, planSlices, sliceViolations, type SliceOutcome, type SlicePlan } from "./swarm-code.ts";
import { buildFanOutPrompt, runSwarm, type FanOutArgs, type SwarmSlot, type SwarmTask } from "./swarm.ts";
import { type State } from "./types.ts";
import { excludeFromGitStatus, gitOk } from "./worktree.ts";
import { zenseDir } from "./types.ts";
import { mkdirSync } from "node:fs";

export const createCodeSwarm = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const pi = ctx.pi;
	const launchSubagent = ctx.launchSubagent;

	const gitIn = (repo: string, args: string[]): { ok: boolean; out: string } => {
		const r = gitOk(args, repo);
		return { ok: r.ok, out: r.out.trim() };
	};

	const workerWorktree = (repo: string, dir: string, branch: string): boolean => {
		mkdirSync(dirname(dir), { recursive: true });
		const have = gitIn(repo, ["rev-parse", "--verify", "-q", branch]).ok;
		const add = have ? gitIn(repo, ["worktree", "add", dir, branch]) : gitIn(repo, ["worktree", "add", dir, "-b", branch]);
		if (add.ok) excludeFromGitStatus(repo, join(zenseDir(repo), "worktree"));
		return add.ok;
	};

	const dropWorkerWorktree = (repo: string, dir: string, branch: string): void => {
		gitIn(repo, ["worktree", "remove", "--force", dir]);
		gitIn(repo, ["branch", "-D", branch]);
	};

	const sliceDiff = (repo: string, dir: string, paths: string[]): string => {
		const files = paths.length ? paths : ["."];
		const tracked = gitIn(dir, ["diff", "HEAD", "--", ...files]);
		return tracked.ok ? tracked.out : "";
	};

	const applySlice = (repo: string, diff: string): { ok: boolean; msg: string } => {
		if (!diff.trim()) return { ok: true, msg: "no changes" };
		try {
			execFileSync("git", ["apply", "--3way", "-"], { cwd: repo, input: diff, stdio: ["pipe", "pipe", "pipe"] });
			return { ok: true, msg: "applied" };
		} catch (e: any) {
			return { ok: false, msg: (e?.stderr?.toString() ?? e?.message ?? String(e)).split("\n")[0] };
		}
	};

	const armGoalRound = (text: string): void => {
		const kick = `GOAL-STILL-OPEN — the driver handed this round back to you (no human will approve anything):\n${text}`;
		try {
			pi.sendUserMessage(kick, { deliverAs: "followUp" });
		} catch {
		}
	};

	const runCodeSwarm = async (
		ctx: ExtensionContext,
		slices: { id: string; instruction: string; scope?: string[] }[],
		opts: { slots: SwarmSlot[]; concurrency: number; maxAttempts: number; goal?: string; sig?: AbortSignal; ladder: string[]; source: string; notes: string },
	): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> => {
		let plans: SlicePlan[];
		try {
			plans = planSlices(slices, join(zenseDir(ctx.cwd), "worktree", "swarm"), new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
		} catch (e) {
			return { content: [{ type: "text", text: `zense_swarm code refused: ${(e as Error).message}` }], details: { refused: true }, isError: true };
		}
		const outcomes: SliceOutcome[] = [];
		const byPlan = new Map(plans.map((pl) => [pl.id, pl]));
		const tasks = slices.map((sl) => ({ id: sl.id, payload: sl }));
		const results = await runSwarm(tasks, {
			slots: opts.slots,
			concurrency: opts.concurrency,
			maxAttempts: opts.maxAttempts,
			run: async (task, slot, attempt) => {
				const plan = byPlan.get(task.id)!;
				if (opts.sig?.aborted) return { ok: false, output: "cancelled by user (Esc)" };
				if (!workerWorktree(ctx.cwd, plan.worktreeDir, plan.branch)) return { ok: false, output: `could not create the worker worktree ${plan.worktreeDir} (branch ${plan.branch})` };
				const prompt = buildCodeWorkerPrompt(task.payload!, { worktreeDir: plan.worktreeDir, scopes: plan.scopes, ...(opts.goal ? { goal: opts.goal } : {}) });
				const before = state.subagentRuns.length;
				const pending = launchSubagent(ctx, "swarm", prompt, undefined, opts.sig, slot.model);
				const started = state.subagentRuns[before];
				if (started) started.slotId = `${slot.id}·${plan.id}`;
				const r = await pending;
				try {
					if (!r.ok) return { ok: false, output: `${r.output}\n(log: ${r.logPath})` };
					const reported = parseWorkerFiles(r.output);
					const changed = reported.length ? reported : gitIn(plan.worktreeDir, ["diff", "--name-only", "HEAD"]).out.split("\n").filter(Boolean);
					const violations = sliceViolations(changed, (rel) => {
						const abs = join(plan.worktreeDir, rel);
						try {
							return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
						} catch {
							return undefined;
						}
					});
					if (violations.length) {
						learn(ctx, `swarm code: slice ${plan.id} broke the code rules — handed back to a coder (${violations.length} violation(s))`);
						return { ok: false, output: `your slice broke the code rules — fix these in your checkout, then report FILES: again\n${formatHygieneViolations(violations)}` };
					}
					const diff = sliceDiff(ctx.cwd, plan.worktreeDir, changed);
					outcomes.push({ id: plan.id, ok: true, paths: changed, diff, output: r.output });
					return { ok: true, output: r.output };
				} finally {
					dropWorkerWorktree(ctx.cwd, plan.worktreeDir, plan.branch);
				}
			},
		});
		const mergePlan = planMerge(outcomes);
		const applied: string[] = [];
		const failedApplies: string[] = [];
		for (const step of mergePlan.steps) {
			if (!step.apply) continue;
			const o = outcomes.find((x) => x.id === step.id)!;
			const res = applySlice(ctx.cwd, o.diff ?? "");
			if (res.ok) applied.push(o.id);
			else failedApplies.push(`${o.id}: ${res.msg}`);
		}
		const failed = results.filter((r) => !r.ok);
		learn(ctx, `swarm code: ${outcomes.length}/${results.length} coder(s) produced work — merge ${applied.length} applied, ${mergePlan.blocked.length} blocked, ${failedApplies.length} apply-failed — ladder ${opts.ladder.join(" > ")} (${opts.source})${opts.notes}`);
		const lines = [
			`${failed.length || mergePlan.blocked.length || failedApplies.length ? "⚠ code swarm finished with issues" : "✅ code swarm merged"}: ${applied.length}/${results.length} slice(s) applied`,
			mergeReport(mergePlan, outcomes),
		];
		if (failed.length) lines.push(`failed coder(s): ${failed.map((f) => f.id).join(", ")}`);
		if (failedApplies.length) lines.push(`apply failed (resolve by hand): ${failedApplies.join(" · ")}`);
		if (mergePlan.overlaps.length) lines.push("overlapping slices were NOT merged — split the work so each file has one owner, or merge those by hand");
		lines.push("leftovers: worker worktrees were removed; any worktree a coder created and changed the path of lives under .zense/worktree/swarm/");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode: "code", applied, blocked: mergePlan.blocked, overlaps: mergePlan.overlaps, failedApplies, results },
			...(failed.length || mergePlan.blocked.length || failedApplies.length ? { isError: true } : {}),
		};
	};

	return { runCodeSwarm };
};
