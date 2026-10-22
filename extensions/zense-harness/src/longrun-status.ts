
import type { LongRunRef, State, Tracker } from "./types.ts";
import { findPhase, loadTracker } from "./longrun.ts";

export const longrunStatusText = (cwd: string, lr: LongRunRef | undefined, cyclePhase: State["phase"]): string | undefined => {
	if (!lr) return undefined;
	const t: Tracker | null = loadTracker(cwd, lr.slug);
	if (!t || t.status !== "active") return undefined;
	const done = t.phases.filter((p) => p.status === "done").length;
	const phase = lr.activePhase ? findPhase(t, lr.activePhase) : undefined;
	const phaseSeg = phase ? `${phase.id} ${phase.title}` : "(between phases)";
	return `zense · ${t.slug} ${done}/${t.phases.length} · ${phaseSeg} · ${cyclePhase}`;
};
