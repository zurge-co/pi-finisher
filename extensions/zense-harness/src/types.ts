
import { join } from "node:path";

export interface Criterion {
	id: string; text: string; check: string; verified?: boolean;
	origin?: "tracker" | "compiled"; }
export interface Spec {
	version: number;
	title: string;
	intent: string;
	outcomes?: string;         	crossCheck?: string[];     	approach?: string[];       	scope: string[];           	constraints: string[];
	criteria: Criterion[];
	specDebt: string[];        	approved: boolean;
	approvedAt?: number;
	approvedBy?: string;         	changesFrom?: string[];    }
export interface State {
	phase: "requirements" | "design" | "implementation" | "eval" | "review" | "maintenance";
	spec?: Spec;
	turnsUsed: number;
	tokensUsed: number;
	escalations: { kind: string; detail: string; at: number }[];
	trajectoryFlags: string[];
	subagentRuns: SubagentRun[];
	lastCompileLessons?: number;    	specSource?: "set" | "compile"; 	baselineHead?: string;      	evalOverrideFails?: { specVersion: number; ids: string[]; count: number }; 	specMdPath?: string;            	specJsonPath?: string;          	contextBulletin?: string;      	verifyLoop?: { round: number; fingerprints: string[]; caseRounds: Record<string, number> };
	decisions?: { at: number; from: string; question: string; assumption: string }[]; 	freshResetAt?: number; 	goalHeld?: boolean; 	goalDriver?: { goal: string; confirmedAt: number; loop: { round: number; fingerprints: string[]; caseRounds: Record<string, number> }; doneAt?: number; outcome?: "verified" | "stopped" | "exhausted" }; 	hygieneViolations?: HygieneViolationRef[]; }

export interface HygieneViolationRef {
	path: string;
	kind: "comment" | "length" | "exempt-without-reason";
	line?: number;
	detail: string;
}
export interface SubagentRun {
	role: string;
	ok: boolean;
	summary: string;
	at: number;
	startedAt?: number;
	logPath?: string;            	model?: string;              	status?: "running" | "done" | "failed";
	retried?: boolean;           	autoIncluded?: boolean;      	streamTail?: string;         	slotId?: string;             	handoffItems?: number;       	decisions?: number;          }
export interface Worktree {
	root: string;               	branch: string;             	dir: string;                	baseline?: string;          }
export interface PendingApply {
	specVersion: number;
	branch: string;             	paths: string[];            	appliedAt: number;
	preApplyHead?: string;      }

export interface LongRunRef {
	slug: string;
	trackerVersion: number;
	activePhase?: string;
	awaitingFinalApply?: boolean; 	auto?: boolean;              	autoFixRounds?: number;      }

export const zenseDir = (cwd: string) => join(cwd, ".zense");
