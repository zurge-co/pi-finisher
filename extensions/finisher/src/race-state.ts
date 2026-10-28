import { allLapsDone, planOf, totalPhases, type GoalPhase } from "./goal-phase.ts";

export type RacePhase = "idle" | "plan" | "run" | "verify" | "win" | "dnf";

export interface RaceGoal {
	goal: string;
	confirmedAt?: number;
	doneAt?: number;
	outcome?: "verified" | "needs-human" | "halted";
	phases?: GoalPhase[];
	lap?: number;
	lapAt?: number;
	lapMs?: number[];
}

export interface RaceRun {
	role: string;
	status?: "running" | "done" | "failed";
}

export interface RaceInput {
	goal?: RaceGoal;
	runs?: RaceRun[];
	now?: number;
}

export interface Race {
	phase: RacePhase;
	lap: number;
	laps: number;
	lapClock: string;
	totalClock: string;
	done: number;
	pitClock: string;
	racedMs: number;
	verifyMs: number;
	totalMs: number;
}

export const clockLabel = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

const stamp = (value: number | undefined): number => (typeof value === "number" && value > 0 ? value : 0);

export const racedMs = (goal: RaceGoal | undefined): number => (goal ? planOf(goal).lapMs.reduce((sum, ms) => sum + Math.max(0, ms ?? 0), 0) : 0);

export const verifyMs = (goal: RaceGoal | undefined, now: number): number => {
	if (!goal) return 0;
	const plan = planOf(goal);
	if (!allLapsDone(plan)) return 0;
	const from = stamp(plan.lapAt);
	if (!from) return 0;
	const end = stamp(goal.doneAt) || now;
	return Math.max(0, end - from);
};

export const pitMs = (goal: RaceGoal | undefined, now: number): number => {
	if (!goal) return 0;
	const started = stamp(goal.confirmedAt);
	if (!started) return 0;
	const end = stamp(goal.doneAt) || now;
	return Math.max(0, end - started - racedMs(goal) - verifyMs(goal, now));
};

export const raceState = (input: RaceInput): Race => {
	const now = input.now ?? Date.now();
	const goal = input.goal;
	const base = { lap: 0, laps: 0, lapClock: "0:00", totalClock: "0:00", done: 0, pitClock: "0:00", racedMs: racedMs(goal), verifyMs: verifyMs(goal, now), totalMs: 0 };
	if (!goal) return { ...base, phase: "idle" };
	const plan = planOf(goal);
	const laps = totalPhases(plan);
	const started = stamp(goal.confirmedAt);
	const end = stamp(goal.doneAt) || now;
	const totalMs = started ? Math.max(0, end - started) : 0;
	const totalClock = clockLabel(totalMs);
	const pitClock = clockLabel(pitMs(goal, now));
	if (goal.doneAt) {
		const won = goal.outcome === "verified";
		return {
			...base,
			laps,
			totalMs,
			done: won ? laps : Math.max(0, Math.min(laps, plan.lap - 1)),
			phase: won ? "win" : "dnf",
			totalClock,
			lapClock: totalClock,
			pitClock,
		};
	}
	if (!laps) return { ...base, totalMs, phase: "plan", totalClock, lapClock: totalClock, pitClock };
	const lap = Math.min(Math.max(1, plan.lap), laps);
	const lapStart = Math.max(stamp(plan.lapAt), stamp(plan.phases[lap - 1]?.addedAt));
	const finished = plan.lap > laps;
	return {
		...base,
		totalMs,
		phase: finished ? "verify" : "run",
		lap: finished ? laps : lap,
		laps,
		lapClock: clockLabel(lapStart ? Math.max(0, now - lapStart) : 0),
		totalClock,
		done: Math.max(0, Math.min(laps, plan.lap - 1)),
		pitClock,
	};
};

const STAGE_TOKEN: Record<RacePhase, string | undefined> = {
	idle: undefined,
	plan: "borderAccent",
	run: "warning",
	verify: "accent",
	win: "success",
	dnf: "error",
};

export const IDLE_TOKEN = "dim";

export const raceStageToken = (race: Race | undefined): string | undefined => (race ? STAGE_TOKEN[race.phase] : undefined);

export const raceStagePaint = (race: Race | undefined): string => raceStageToken(race) ?? IDLE_TOKEN;

export const raceSegment = (race: Race): string => (race.phase === "idle" ? "" : race.totalClock);

export const raceLoaderCaption = (race: Race): string => {
	if (race.phase === "run") return `LAP ${race.lap}/${race.laps} ${race.lapClock}`;
	if (race.phase === "verify") return `VERIFY ${race.lapClock}`;
	if (race.phase === "win") return `FINISH ${race.totalClock}`;
	if (race.phase === "dnf") return `DNF ${race.totalClock}`;
	return `PLAN ${race.totalClock}`;
};

export const raceLoaderFrames = (race: Race, fg: (token: string, text: string) => string): { frames: string[] } => {
	const token = raceStageToken(race);
	if (!token) return { frames: [] };
	return { frames: [fg(token, raceLoaderCaption(race))] };
};

export const raceIdleLine = (race: Race, mark: string, name = "", tally = ""): string => {
	const tail = tally ? ` · ${tally}` : "";
	const head = name ? `${mark} ${name}` : mark;
	const clock = raceSegment(race);
	const lead = clock ? `${head} ${clock}` : head;
	if (race.phase === "win") return `${lead} · ${race.laps} laps · pit ${race.pitClock}${tail}`;
	if (race.phase === "dnf") return `${lead} · ${race.done}/${race.laps || "?"} laps · pit ${race.pitClock}`;
	return lead;
};
