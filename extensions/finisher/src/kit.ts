import { type OverlayHandle, type OverlayOptions, type SelectItem } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type State } from "./types.ts";

export type GetState = () => State;

export type Persist = () => void;
export type UpdateWidget = (ctx: ExtensionContext) => void;
export type RescheduleTicker = (ctx: ExtensionContext) => void;
export type Escalate = (kind: string, detail: string, ctx: ExtensionContext) => void;
export type Flag = (msg: string, ctx: ExtensionContext) => void;
export type ArmGoalRound = (text: string) => void;
export type AskRejectReason = (ctx: ExtensionContext, what: string) => Promise<string | undefined>;
export type OpenAgentsViewer = (ctx: ExtensionContext) => Promise<void>;
export type OpenAgentSession = (ctx: ExtensionContext, at?: import("./types.ts").SubagentRun) => Promise<null>;
export type OpenGoalPage = (ctx: ExtensionContext) => Promise<null>;
export type OpenReportPage = (ctx: ExtensionContext) => Promise<null>;

export type LaunchSubagent = (
	ctx: ExtensionContext,
	role: string,
	task: string,
	onChunk?: (chunk: string) => void,
	signal?: AbortSignal,
	modelOverride?: string,
	opts?: { caseId?: string },
) => Promise<{ ok: boolean; output: string; logPath: string; calls?: import("./evidence-record.ts").RecordedCall[] }>;

export type RunCodeSwarm = (
	ctx: ExtensionContext,
	slices: { id: string; instruction: string; scope?: string[]; acceptance?: string[]; dependsOn?: string[]; sharedContract?: string }[],
	opts: {
		slots: any[];
		concurrency: number;
		maxAttempts: number;
		goal?: string;
		sig?: AbortSignal;
		ladder: string[];
		source: string;
		notes: string;
		budget?: string | null;
	},
) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }>;

export interface CustomDialogOptions {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
}

export type FinisherCustom = <T>(
	ctx: ExtensionContext,
	overlay: CustomDialogOptions,
	build: (tui: any, theme: any, kb: (name: string) => string, done: (v: T) => void) => any,
	allowPeek?: (() => boolean) | boolean,
) => Promise<T>;

export type FinisherPick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint?: string) => Promise<string | null>;
export type AskClarify = (ctx: ExtensionContext, q: { question: string; choices?: string[]; freeText?: boolean }) => Promise<string | undefined>;
export type AskGoalConfirm = (ctx: ExtensionContext, goal: string, cases: string[]) => Promise<"confirmed" | "declined" | "unavailable" | "timeout">;
export type AcceptPending = (ctx: ExtensionContext, commitIfStaged: boolean, notifyViaBulletin?: boolean) => { ok: boolean; text: string; specVersion?: number };
export type ScrollAction = { dir: 1 | -1; page: boolean } | "top" | "bottom" | null;
export type ScrollKeyAction = (data: string) => ScrollAction;
export type EscGuard = ReturnType<typeof import("./esc-guard.ts").createEscGuard>;

export interface HarnessContext {
	pi: ExtensionAPIRef;
	state: State;
	persist: Persist;
	updateWidget: UpdateWidget;
	rescheduleTicker: RescheduleTicker;
	flag: Flag;
	escalate: Escalate;
	launchSubagent: LaunchSubagent;
	runCodeSwarm: RunCodeSwarm;
	armGoalRound: ArmGoalRound;
	askGoalConfirm: AskGoalConfirm;
	askClarifyQuestion: AskClarify;
	acceptPending: AcceptPending;
	finisherPick: FinisherPick;
	openAgentsViewer: OpenAgentsViewer;
	openAgentSession: OpenAgentSession;
	openGoalPage: OpenGoalPage;
	openReportPage: OpenReportPage;
	finisherCustom: FinisherCustom;
	OVERLAY_LG: CustomDialogOptions;
	OVERLAY_MD: CustomDialogOptions;
	OVERLAY_XL: CustomDialogOptions;
	scrollKeyAction: ScrollKeyAction;
	REJECT_WITH_REASON: string;
	askRejectReason: AskRejectReason;
	escGuard: EscGuard;
	escGuardUnsubscribe?: () => void;
}

export type ExtensionAPIRef = import("@earendil-works/pi-coding-agent").ExtensionAPI;
