import { test } from "node:test";
import assert from "node:assert/strict";
import { consentBlocks, createStateBox, freshState, humanResumes } from "../extensions/finisher/index.ts";

test("the state box keeps one object for the whole session: a restore cannot orphan the state every kit captured", () => {
	const box = createStateBox(freshState());
	const captured = box.get();
	box.set({ ...freshState(), humanAt: 42 });
	assert.equal(box.get(), captured, "set must fill the same object, not replace it — a kit that read ctx.state once must still see the truth");
	assert.equal(captured.humanAt, 42, "a write through the box is visible through the reference a kit captured earlier");
	captured.goalConsent = { blockedAt: 1, reason: "declined" };
	assert.deepEqual(box.get().goalConsent, { blockedAt: 1, reason: "declined" }, "and the other direction: a kit's write is the box's state");
});

test("a restored snapshot fully replaces the old state: keys that the session did not have are gone, not left behind", () => {
	const box = createStateBox(freshState());
	box.get().humanAt = 7;
	box.get().goalConsent = { blockedAt: 7, reason: "timeout" };
	const restored = freshState();
	box.set(restored);
	assert.equal(box.get().humanAt, undefined, "a fresh session must not inherit a stale human turn");
	assert.equal(box.get().goalConsent, undefined, "nor a stale refusal");
	assert.deepEqual(Object.keys(box.get()).sort(), Object.keys(restored).sort(), "the box holds exactly the restored shape");
});

test("the consent block lifts exactly when the human speaks, and never before", () => {
	for (const reason of ["declined", "timeout"]) {
		const consent = { blockedAt: 1_000, reason };
		assert.equal(consentBlocks(consent, undefined), true, "a refusal with no human turn after it blocks");
		assert.equal(consentBlocks(consent, 1_000), true, "a turn at the same instant is not a new message");
		assert.equal(consentBlocks(consent, 999), true, "an earlier turn is not a new message");
		assert.equal(consentBlocks(consent, 1_001), false, `${reason}: the human spoke afterwards, so the goal can be asked again`);
	}
	assert.equal(consentBlocks(undefined, 0), false, "with no refusal recorded nothing is blocked");
});

test("a human message clears the refusal so the dialog can open again, and reports that it did", () => {
	const state = { humanAt: 500, goalConsent: { blockedAt: 1_000, reason: "declined" } };
	assert.equal(humanResumes(state, 2_000), true, "a refusal that was pending is lifted");
	assert.equal(state.goalConsent, undefined);
	assert.equal(state.humanAt, 2_000);
	assert.equal(consentBlocks(state.goalConsent, state.humanAt), false, "the gate is open after the human speaks");
	assert.equal(humanResumes(state, 3_000), false, "with nothing pending, a message changes nothing else");
	assert.equal(state.humanAt, 3_000, "the human turn is still recorded");
});
