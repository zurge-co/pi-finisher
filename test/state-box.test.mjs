import { test } from "node:test";
import assert from "node:assert/strict";
import { consentBlocks, createStateBox, freshState, humanResumes, humanTurnsFrom, UNKNOWN_HUMAN_TURNS, UNKNOWN_SESSION } from "../extensions/finisher/index.ts";

test("the state box keeps one object for the whole session: a restore cannot orphan the state every kit captured", () => {
	const box = createStateBox(freshState());
	const captured = box.get();
	box.set({ ...freshState(), humanAt: 42 });
	assert.equal(box.get(), captured, "set must fill the same object, not replace it — a kit that read ctx.state once must still see the truth");
	assert.equal(captured.humanAt, 42, "a write through the box is visible through the reference a kit captured earlier");
	captured.goalConsent = { humanTurns: 3, reason: "declined" };
	assert.deepEqual(box.get().goalConsent, { humanTurns: 3, reason: "declined" }, "and the other direction: a kit's write is the box's state");
});

test("a restored snapshot fully replaces the old state: keys that the session did not have are gone, not left behind", () => {
	const box = createStateBox(freshState());
	box.get().humanAt = 7;
	box.get().goalConsent = { humanTurns: 7, reason: "timeout" };
	const restored = freshState();
	box.set(restored);
	assert.equal(box.get().humanAt, undefined, "a fresh session must not inherit a stale human turn");
	assert.equal(box.get().goalConsent, undefined, "nor a stale refusal");
	assert.deepEqual(Object.keys(box.get()).sort(), Object.keys(restored).sort(), "the box holds exactly the restored shape");
});

test("the consent block lifts exactly when the human speaks, and never before", () => {
	const sessionId = "session-1";
	for (const reason of ["declined", "timeout"]) {
		const consent = { humanTurns: 3, reason, sessionId };
		assert.equal(consentBlocks(consent, { humanTurns: 3, sessionId }), true, "the same human turn that was refused is never asked again");
		assert.equal(consentBlocks(consent, { humanTurns: 4, sessionId }), false, `${reason}: the human spoke after the refusal, so the goal can be asked again`);
		assert.equal(consentBlocks(consent, { humanTurns: 2, sessionId }), false, "a restarted or compacted transcript must never stay trapped in an old refusal");
		assert.equal(consentBlocks(consent, { humanTurns: UNKNOWN_HUMAN_TURNS, sessionId }), false, "and a turn count that cannot be read never traps the run either");
	}
	assert.equal(consentBlocks(undefined, { humanTurns: 0 }), false, "with no refusal recorded nothing is blocked");
	assert.equal(humanTurnsFrom([{ type: "message", message: { role: "user" } }, { type: "message", message: { role: "assistant" } }, { type: "custom" }]), 1, "only real human messages count as a turn");
	assert.equal(humanTurnsFrom(undefined), UNKNOWN_HUMAN_TURNS, "an unreadable session is unknown, not zero");
});

test("a refusal belongs to one session: a matching turn count in another run cannot keep the dialog shut", () => {
	const consent = { humanTurns: 5, reason: "declined", sessionId: "session-1" };
	assert.equal(consentBlocks(consent, { humanTurns: 5, sessionId: "session-1" }), true, "the run that was refused does not nag the human again");
	assert.equal(consentBlocks(consent, { humanTurns: 5, sessionId: "session-2" }), false, "a fresh context whose count happens to match is another run: the human is asked instead of being locked out");
	assert.equal(consentBlocks(consent, { humanTurns: 5, sessionId: UNKNOWN_SESSION }), false, "an unreadable session id cannot prove this is the refusing run");
	assert.equal(consentBlocks({ humanTurns: 5, reason: "declined" }, { humanTurns: 5, sessionId: "session-1" }), false, "a snapshot from before sessions were recorded never blocks the human");
});

test("a human message clears the refusal so the dialog can open again, and reports that it did", () => {
	const state = { humanAt: 500, goalConsent: { humanTurns: 3, reason: "declined", sessionId: "s1" } };
	assert.equal(consentBlocks(state.goalConsent, { humanTurns: 3, sessionId: "s1" }), true, "while the human is silent the run stays stopped");
	assert.equal(humanResumes(state, 2_000), true, "a refusal that was pending is lifted");
	assert.equal(state.goalConsent, undefined);
	assert.equal(state.humanAt, 2_000);
	assert.equal(consentBlocks(state.goalConsent, { humanTurns: 3, sessionId: "s1" }), false, "the gate is open after the human speaks");
	assert.equal(humanResumes(state, 3_000), false, "with nothing pending, a message changes nothing else");
	assert.equal(state.humanAt, 3_000, "the human turn is still recorded");
});
