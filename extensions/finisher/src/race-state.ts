import { allLapsDone, lapLabel, planOf, totalPhases, type GoalPhase } from "./goal-phase.ts";

export const RACE_LANES = 5;
export const RACE_LIGHT_ON = "●";
export const RACE_LIGHT_OFF = "○";
export const RACE_LIGHT_DNF = "✕";

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
	lanes?: number;
	now?: number;
}

export interface Race {
	phase: RacePhase;
	caption: string;
	lap: number;
	laps: number;
	lanes: number;
	busy: number;
	lights: boolean[];
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

const clampLanes = (n: number | undefined): number => Math.min(RACE_LANES, Math.max(1, Math.floor(n ?? RACE_LANES)));

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
	const lanes = clampLanes(input.lanes);
	const busy = Math.min(lanes, (input.runs ?? []).filter((r) => r.status === "running").length);
	const lights = Array.from({ length: lanes }, (_, i) => i < busy);
	const goal = input.goal;
	const base = { lanes, busy, lights, lap: 0, laps: 0, lapClock: "0:00", totalClock: "0:00", done: 0, pitClock: "0:00", racedMs: racedMs(goal), verifyMs: verifyMs(goal, now), totalMs: 0 };
	if (!goal) return { ...base, phase: "idle", caption: "READY" };
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
			caption: won ? "P1" : `DNF · ${goal.outcome === "halted" ? "halted" : "needs you"}`,
			totalClock,
			lapClock: totalClock,
			pitClock,
		};
	}
	if (!laps) return { ...base, totalMs, phase: "plan", caption: "PLAN", totalClock, lapClock: totalClock, pitClock };
	const lap = Math.min(Math.max(1, plan.lap), laps);
	const lapStart = Math.max(stamp(plan.lapAt), stamp(plan.phases[lap - 1]?.addedAt));
	const finished = plan.lap > laps;
	return {
		...base,
		totalMs,
		phase: finished ? "verify" : "run",
		caption: finished ? "VERIFY" : lapLabel(plan),
		lap: finished ? laps : lap,
		laps,
		lapClock: clockLabel(lapStart ? Math.max(0, now - lapStart) : 0),
		totalClock,
		done: Math.max(0, Math.min(laps, plan.lap - 1)),
		pitClock,
	};
};

export const raceLightsText = (race: Race): string => {
	if (race.phase === "dnf") return RACE_LIGHT_DNF.repeat(race.lanes);
	if (race.phase === "win") return RACE_LIGHT_ON.repeat(race.lanes);
	return race.lights.map((on) => (on ? RACE_LIGHT_ON : RACE_LIGHT_OFF)).join("");
};

export const raceLampToken = (race: Race): string => {
	if (race.phase === "dnf") return "error";
	if (race.phase === "win") return "success";
	if (race.phase === "verify") return "borderAccent";
	if (race.phase === "run") return "accent";
	return "dim";
};

export const raceSegment = (race: Race): string =>
	race.phase === "run" || race.phase === "verify" ? `${raceLightsText(race)} ${race.caption} ${race.lapClock}` : `${raceLightsText(race)} ${race.caption}`;

export const raceLoaderCaption = (race: Race): string => {
	if (race.phase === "run") return `${race.caption} ${race.lapClock}`;
	if (race.phase === "verify") return `VERIFY ${race.lapClock}`;
	if (race.phase === "win") return `P1 ${race.totalClock}`;
	if (race.phase === "dnf") return `DNF ${race.totalClock}`;
	return `${race.caption} ${race.totalClock}`;
};

export const raceLoaderFrames = (race: Race, fg: (token: string, text: string) => string): { frames: string[]; intervalMs?: number } => {
	const token = raceLampToken(race);
	const lit = (on: boolean): string => fg(on ? token : "dim", on ? RACE_LIGHT_ON : RACE_LIGHT_OFF);
	if (race.phase === "dnf") return { frames: [fg("error", RACE_LIGHT_DNF.repeat(race.lanes))] };
	if (race.phase === "win") return { frames: [fg("success", RACE_LIGHT_ON.repeat(race.lanes))] };
	const steady = race.lights.map(lit).join("");
	if (race.phase === "idle" || race.phase === "plan") return { frames: [steady] };
	const pulseAt = race.lights.findIndex((on) => !on);
	if (pulseAt < 0) return { frames: [steady], intervalMs: 900 };
	const pulse = race.lights.map((on, i) => (i === pulseAt ? fg(token, RACE_LIGHT_ON) : lit(on))).join("");
	return { frames: [steady, pulse], intervalMs: 520 };
};

export const raceLoaderMessage = (race: Race): string => ` ${raceLoaderCaption(race)}`;

export const raceIdleLine = (race: Race, mark: string, name = "finisher", tally = ""): string => {
	const tail = tally ? ` · ${tally}` : "";
	if (race.phase === "win") return `${mark} ${name} · ${raceSegment(race)} · ${race.totalClock} · ${race.laps} laps · pit ${race.pitClock}${tail}`;
	if (race.phase === "dnf") return `${mark} ${name} · ${raceSegment(race)} · ${race.totalClock} · ${race.done}/${race.laps || "?"} laps · pit ${race.pitClock}`;
	return `${mark} ${name} · ${raceSegment(race)}`;
};
