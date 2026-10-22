
import { join } from "node:path";
import { type ProbeResult } from "./evidence.ts";

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
	gateEnabled: boolean;
	subagentRuns: SubagentRun[];
	lastCompileLessons?: number;    	specSource?: "set" | "compile"; 	lastEval?: { verdict: string; perCriteria: Record<string, string>; failedIds: string[]; probes: ProbeResult[]; at: number; specVersion?: number; head?: string }; 	baselineHead?: string;      	evalOverrideFails?: { specVersion: number; ids: string[]; count: number }; 	specMdPath?: string;            	specJsonPath?: string;          	worktree?: Worktree | null;     	longRun?: LongRunRef;           	pendingLongrunCompact?: { slug: string; summary: string }; 	worktreeLeaveNotified?: boolean; 	pendingApply?: PendingApply;    	contextBulletin?: string;      	verifyLoop?: { round: number; fingerprints: string[]; caseRounds: Record<string, number> };
	goalDriver?: { goal: string; confirmedAt: number; loop: { round: number; fingerprints: string[]; caseRounds: Record<string, number> }; doneAt?: number; outcome?: "verified" | "stopped" | "exhausted" }; 	hygieneViolations?: HygieneViolationRef[]; }

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
	retried?: boolean;           	autoIncluded?: boolean;      	streamTail?: string;         	slotId?: string;             }
export interface Worktree {
	root: string;               	branch: string;             	dir: string;                	baseline?: string;          }
export interface PendingApply {
	specVersion: number;
	branch: string;             	paths: string[];            	appliedAt: number;
	preApplyHead?: string;      }

export interface TrackerPhase {
	id: string;                  	title: string;
	intent: string;
	outcomes?: string;           	crossCheck?: string[];       	scope: string[];
	constraints: string[];
	criteria: Criterion[];       	status: "pending" | "active" | "done" | "failed";
	baseline?: string;           	checkpoint?: string;         	specVersion?: number;
	adrs?: number[];
	summaryPath?: string;        	verdict?: string;            	criteriaVerdicts?: Record<string, string>; 	filesChanged?: string[];     }
export interface Tracker {
	version: number;             	slug: string;                	title: string;
	intent: string;
	outcomes?: string;           	crossCheck?: string[];       	worktreeBranch: string;      	status: "planning" | "active" | "done" | "abandoned";
	auto?: boolean;              	phases: TrackerPhase[];
	approvedAt?: number;
	updatedAt: number;
}
export interface LongRunRef {
	slug: string;
	trackerVersion: number;
	activePhase?: string;
	awaitingFinalApply?: boolean; 	auto?: boolean;              	autoFixRounds?: number;      }

export const zenseDir = (cwd: string) => join(cwd, ".zense");
