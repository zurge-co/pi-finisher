import { type OverlayOptions, type SelectItem } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type State } from "./types.ts";

export type Learn = (ctx: ExtensionContext, note: string) => void;
export type GetState = () => State;

export type Persist = () => void;
export type UpdateWidget = (ctx: ExtensionContext) => void;
export type RescheduleTicker = (ctx: ExtensionContext) => void;
export type ApplyRedirect = (ev: any, ctx: ExtensionContext) => void;
export type Escalate = (kind: string, detail: string, ctx: ExtensionContext) => void;
export type Flag = (msg: string, ctx: ExtensionContext) => void;
export type ArmGoalRound = (text: string) => void;
export type AskRejectReason = (ctx: ExtensionContext, what: string) => Promise<string | undefined>;
export type OpenAgentsViewer = (ctx: ExtensionContext) => Promise<void>;

export type LaunchSubagent = (
	ctx: ExtensionContext,
	role: string,
	task: string,
	onChunk?: (chunk: string) => void,
	signal?: AbortSignal,
	modelOverride?: string,
) => Promise<{ ok: boolean; output: string; logPath: string }>;

export type RunCodeSwarm = (
	ctx: ExtensionContext,
	slices: { id: string; instruction: string; scope?: string[] }[],
	opts: {
		slots: any[];
		concurrency: number;
		maxAttempts: number;
		goal?: string;
		sig?: AbortSignal;
		ladder: string[];
		source: string;
		notes: string;
	},
) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }>;

export type ZenseCustom = <T>(
	ctx: ExtensionContext,
	overlay: OverlayOptions,
	build: (tui: any, theme: any, kb: (name: string) => string, done: (v: T) => void) => any,
	allowPeek?: (() => boolean) | boolean,
) => Promise<T>;

export type ZensePick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint?: string) => Promise<string | null>;
export type ExtConfigDialog = (ctx: ExtensionContext, role: string, items: { path: string; label: string; checked: boolean }[]) => Promise<string[] | null>;
export type AskClarify = (ctx: ExtensionContext, q: { question: string; choices?: string[]; freeText?: boolean }) => Promise<string | undefined>;
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
	learn: Learn;
	flag: Flag;
	escalate: Escalate;
	applyRedirect: ApplyRedirect;
	launchSubagent: LaunchSubagent;
	runCodeSwarm: RunCodeSwarm;
	armGoalRound: ArmGoalRound;
	askClarifyQuestion: AskClarify;
	acceptPending: AcceptPending;
	zensePick: ZensePick;
	extConfigDialog: ExtConfigDialog;
	openAgentsViewer: OpenAgentsViewer;
	zenseCustom: ZenseCustom;
	OVERLAY_LG: OverlayOptions;
	OVERLAY_MD: OverlayOptions;
	OVERLAY_XL: OverlayOptions;
	scrollKeyAction: ScrollKeyAction;
	REJECT_WITH_REASON: string;
	askRejectReason: AskRejectReason;
	escGuard: EscGuard;
	escGuardUnsubscribe?: () => void;
}

export type ExtensionAPIRef = import("@earendil-works/pi-coding-agent").ExtensionAPI;
