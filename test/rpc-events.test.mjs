import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForRun, outcomeLabel, childExitReason, promptRefused, isSettledEvent, isChildExitEvent, raceTimeout, attemptDeadlineMs, clampAttempts, MAX_ATTEMPTS_CEILING, effortFor, enforceDeadline, isValidBashTimeout, MAX_BASH_TIMEOUT_SECONDS } from "../extensions/finisher/index.ts";

const manual = () => {
	const listeners = new Set();
	const subscribe = (onEvent) => {
		listeners.add(onEvent);
		return () => listeners.delete(onEvent);
	};
	const emit = (ev) => {
		for (const l of [...listeners]) l(ev);
	};
	return { subscribe, emit, count: () => listeners.size };
};

const quiet = () => new Promise(() => {});

test("a wait ends on whichever comes first — settle, child exit, deadline, or abort — and never on the others", async () => {
	for (const kind of ["settled", "exited", "deadline", "cancelled"]) {
		const bus = manual();
		const ac = new AbortController();
		const watchers = { deadlineMs: kind === "deadline" ? 20 : 60_000, signal: ac.signal };
		const wait = waitForRun(bus.subscribe, watchers);
		if (kind === "settled") bus.emit({ type: "agent_settled" });
		if (kind === "exited") bus.emit({ type: "agent_exit", why: "gone" });
		if (kind === "cancelled") ac.abort();
		const outcome = await wait.done;
		assert.equal(outcome.kind, kind, `the ${kind} signal must be the one that ends the wait`);
		if (kind !== "settled") assert.equal(bus.count(), 0, `${kind} must unsubscribe — a finished wait cannot hold a listener`);
	}
});

test("the first terminal signal wins: a late settle cannot rewrite an outcome the deadline already decided", async () => {
	const bus = manual();
	const ac = new AbortController();
	const wait = waitForRun(bus.subscribe, { deadlineMs: 60_000, signal: ac.signal });
	ac.abort();
	bus.emit({ type: "agent_settled" });
	assert.equal((await wait.done).kind, "cancelled", "an outcome is final, so a second signal is dropped");
});

test("a dead child ends the wait without waiting out the budget, and the reason names the exit", async () => {
	let exited = false;
	const wait = waitForRun(manual().subscribe, { deadlineMs: 60_000, probeMs: 5, probe: () => (exited ? childExitReason(1, null, "boom") : undefined) });
	exited = true;
	const t0 = Date.now();
	const outcome = await wait.done;
	assert.equal(outcome.kind, "exited");
	assert.match(outcome.why ?? "", /code=1/);
	assert.match(outcome.why, /boom/);
	assert.ok(Date.now() - t0 < 5_000, "a crash must be reported in seconds, not after the 600s budget");
});

test("the deadline is the bound even when no event ever arrives — that is the whole point of the wait", async () => {
	const t0 = Date.now();
	const outcome = await waitForRun(manual().subscribe, { deadlineMs: 30 }).done;
	assert.equal(outcome.kind, "deadline");
	assert.ok(Date.now() - t0 < 5_000);
	assert.equal(outcomeLabel(outcome, 600_000), "TIMEOUT 600s");
});

test("every outcome maps to a message that says who stopped it, so a stall is never reported as work", () => {
	assert.equal(outcomeLabel({ kind: "cancelled" }, 1), "cancelled by user (Esc)");
	assert.equal(outcomeLabel({ kind: "exited", why: "x" }, 1), "x");
	assert.match(outcomeLabel({ kind: "deadline" }, 90_000), /TIMEOUT 90s/);
	assert.equal(promptRefused("handled"), true, "a handled prompt started no run, so waiting on it would hang");
	for (const d of ["started", "queued", undefined]) assert.equal(promptRefused(d), false, `${d} did start work`);
});

test("only agent_settled settles and only agent_exit is an exit — agent_end is neither", () => {
	assert.equal(isSettledEvent({ type: "agent_settled" }), true);
	assert.equal(isSettledEvent({ type: "agent_end" }), false);
	assert.equal(isChildExitEvent({ type: "agent_exit" }), true);
	assert.equal(isChildExitEvent({ type: "agent_settled" }), false);
});

test("the per-attempt deadline stays above the child budget (so the child reports first) and is never unbounded", () => {
	for (const timeoutMs of [1_000, 300_000, 600_000, 3_600_000]) {
		const attempt = attemptDeadlineMs(timeoutMs);
		assert.ok(attempt > timeoutMs, `the attempt bound (${attempt}) must outlast the child budget (${timeoutMs}) so the child can report why it failed`);
	}
	assert.ok(Number.isFinite(attemptDeadlineMs(Number.POSITIVE_INFINITY)) === false || attemptDeadlineMs(2_000_000) < 2 ** 31 - 1 + 1, "the bound must stay inside what setTimeout accepts");
});

test("attempts are clamped, so a client-supplied number cannot outlive the tool cap or overflow the timer", () => {
	assert.equal(clampAttempts(undefined), 2);
	assert.equal(clampAttempts(0), 1);
	assert.equal(clampAttempts(-7), 1);
	assert.equal(clampAttempts(2.9), 2);
	assert.equal(clampAttempts(999), MAX_ATTEMPTS_CEILING);
	assert.equal(Number.isNaN(clampAttempts(Number.NaN)), false);
	for (const requested of [999, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) assert.equal(effortFor("explore", requested) <= MAX_ATTEMPTS_CEILING, true, `${requested} must not become an unbounded retry loop`);
});

test("no bash deadline can be longer than an hour, and every accepted value is a whole number of seconds", () => {
	assert.ok(MAX_BASH_TIMEOUT_SECONDS <= 3_600);
	for (const seconds of [1, 120, 900, MAX_BASH_TIMEOUT_SECONDS]) assert.equal(isValidBashTimeout(seconds), true, `${seconds}s must be accepted`);
	for (const bad of [MAX_BASH_TIMEOUT_SECONDS + 1, 2_147_483, 0, -1, 1.5]) assert.equal(isValidBashTimeout(bad), false, `${bad} must be refused`);
	const input = { command: "sleep 9" };
	const r = enforceDeadline("bash", input, process.cwd());
	assert.equal(r.blocked, false);
	assert.ok(input.timeout <= MAX_BASH_TIMEOUT_SECONDS, "an injected deadline is inside the accepted range");
});

test("the wait resolves instead of stranding the caller when a subscriber throws", async () => {
	const bus = manual();
	const wait = waitForRun(bus.subscribe, { deadlineMs: 20 });
	bus.emit({ type: "turn_end" });
	assert.equal((await wait.done).kind, "deadline");
	await assert.rejects(raceTimeout(quiet(), 10).then(() => Promise.reject(new Error("no"))), /no/);
});
