
import { type State } from "./types.ts";

export const resetCycleState = (s: State): void => {
	s.spec = undefined;
	s.phase = "requirements";
	s.evalOverrideFails = undefined;
	s.specSource = undefined;
	s.specMdPath = undefined;
	s.specJsonPath = undefined;
	s.lastCompileLessons = undefined;
	s.goalDriver = undefined;
	s.goalConsent = undefined;
	s.goalStop = undefined;
	s.verifyLoop = undefined;
};

export const takeContextBulletin = (s: { contextBulletin?: string }): string | undefined => {
	const b = s.contextBulletin;
	if (b !== undefined) s.contextBulletin = undefined;
	return b;
};

export const buildAcceptBulletin = (specVersion: number, title: string, amendedCount: number): string =>
	`[finisher] spec v${specVersion} "${title}" was accepted + committed on main${amendedCount ? ` (human amended ${amendedCount} file(s) after the grader passed)` : ""} — cycle reset; new work starts at spec v1`;

export const buildReconcileBulletin = (specVersion: number): string =>
	`[finisher] spec v${specVersion}'s pendingApply was closed by the human outside the flow (committed, or the change dropped) — cycle reset; new work starts at spec v1`;

export const buildDiscardBulletin = (specVersion: number): string =>
	`[finisher] spec v${specVersion}'s change was discarded — reverse patch removed it from main — cycle reset; new work starts at spec v1`;

export const freshState = (): State => ({
	phase: "requirements",
	turnsUsed: 0,
	tokensUsed: 0,
	escalations: [],
	trajectoryFlags: [],
	subagentRuns: [],
});
