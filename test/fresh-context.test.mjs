import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FRESH_SUMMARY_MAX,
	buildFreshSummary,
	clipSummary,
	freshCompactionEntry,
	freshStatusLine,
	readFreshContextConfig,
	freshResetDecision,
	lastUserEntryId,
	shouldReset,
	writeFreshContextConfig,
} from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-fresh-"));

test("fresh context is on by default, so a task boundary resets without any setup", () => {
	const cfg = readFreshContextConfig(tmpRepo());
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.source, "default");
});

test("the switch is a real off: it survives the round trip and wins over the default", () => {
	const cwd = tmpRepo();
	assert.equal(writeFreshContextConfig(cwd, false), true);
	const off = readFreshContextConfig(cwd);
	assert.equal(off.enabled, false);
	assert.equal(off.source, "config");
	writeFreshContextConfig(cwd, true);
	assert.equal(readFreshContextConfig(cwd).enabled, true);
});

test("a broken config file never blocks the run — it falls back to the default and says so", () => {
	const cwd = tmpRepo();
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "config.json"), "{ this is not json");
	const cfg = readFreshContextConfig(cwd);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.source, "broken-config");
});

test("a plain reply is never a task boundary: chatting with the agent never compacts the transcript", () => {
	const chat = { enabled: true, hasWork: true };
	assert.equal(shouldReset({ enabled: true, alreadyReset: false, hasWork: true, goalDone: false, freshBoundary: false }), false, "no confirmed goal means no reset");
	const decided = freshResetDecision(chat);
	assert.deepEqual(decided, { reset: false }, "an answer to a question must stay readable");
	assert.equal(freshResetDecision({ ...chat, goal: {} }).reset, false, "a goal that is still open is still the same task");
});

test("exactly one reset per closed goal, and the boundary is consumed so the next reply is left alone", () => {
	const goal = { doneAt: 5_000 };
	const first = freshResetDecision({ enabled: true, hasWork: true, goal, now: 6_000 });
	assert.deepEqual(first, { reset: true, goalAt: 5_000 }, "the settle that closes the goal is the boundary");
	assert.equal(freshResetDecision({ enabled: true, hasWork: true, goal, consumedGoalAt: 5_000, now: 60_000 }).reset, false, "the same boundary can never fire twice");
	assert.equal(freshResetDecision({ enabled: true, hasWork: true, goal: { doneAt: 9_000 }, consumedGoalAt: 5_000, now: 60_000 }).reset, true, "a later goal is a new boundary");
	assert.equal(freshResetDecision({ enabled: true, hasWork: true, goal, lastResetAt: 5_900, now: 6_000 }).reset, false, "two settles of one boundary do not reset twice");
	assert.equal(freshResetDecision({ enabled: true, hasWork: true, goal, aborted: true, now: 6_000 }).reset, false, "an aborted run keeps its context so the human can read it");
	assert.equal(freshResetDecision({ enabled: false, hasWork: true, goal, now: 6_000 }).reset, false, "the switch still wins");
	assert.equal(freshResetDecision({ enabled: true, hasWork: false, goal, now: 6_000 }).reset, false, "nothing was said, so nothing is compacted");
});

test("the retained summary is the handoff stack, never raw statistics", () => {
	const items = [
		{ at: 1, from: "swarm", text: "the merge refuses two slices on one path — split by file" },
		{ at: 2, from: "grader", text: "npm test is the only proof that the bound holds" },
	];
	const summary = buildFreshSummary(items);
	assert.match(summary, /the merge refuses two slices on one path/);
	assert.match(summary, /Re-read the repo/);
	assert.ok(!/\bturns\b|\btokens\b|\d+ files? changed/.test(summary), "no stat lines are carried forward");
	assert.equal(buildFreshSummary([]), "", "an empty stack carries nothing, and the caller supplies a bare directive");
});

test("the summary is capped, so a long stack cannot smuggle a whole transcript back in", () => {
	const items = Array.from({ length: 40 }, (_, i) => ({ at: i, from: "swarm", text: `lesson ${i} `.repeat(40) }));
	const summary = buildFreshSummary(items);
	assert.ok(summary.length <= FRESH_SUMMARY_MAX);
	assert.equal(clipSummary("x".repeat(FRESH_SUMMARY_MAX * 2)).length, FRESH_SUMMARY_MAX);
});

test("the compaction entry is retain-none, which is what makes the next task start empty", () => {
	const entry = freshCompactionEntry("carry this one line");
	assert.equal(entry.type, "compaction");
	assert.equal(entry.firstKeptEntryId, null);
	assert.equal(entry.summary, "carry this one line");
	assert.equal(freshCompactionEntry("").firstKeptEntryId, null);
});

test("the status line tells the human both facts they need: the switch and the stack depth", () => {
	const line = freshStatusLine({ enabled: false, source: "config" }, []);
	assert.match(line, /fresh context: OFF \(config\)/);
	assert.match(line, /0 item/);
	assert.match(freshStatusLine({ enabled: true, source: "default" }, [{ at: 1, from: "swarm", text: "x" }]), /1 item/);
});

test("an empty stack is the normal case under a strict classifier, and it still resets cleanly", () => {
	const empty = buildFreshSummary([]);
	assert.equal(empty, "");
	const directive = empty || "[finisher fresh context] a task finished; this context was reset on purpose. Re-read the repo and state from disk instead of trusting memory.";
	const entry = freshCompactionEntry(directive);
	assert.equal(entry.firstKeptEntryId, null, "an empty stack must still retain nothing");
	assert.ok(entry.summary.length > 0, "the next task still gets one line of orientation");
	assert.ok(entry.summary.length <= FRESH_SUMMARY_MAX);
	assert.equal(shouldReset({ enabled: true, alreadyReset: false, hasWork: true, goalDone: true, freshBoundary: true }), true, "the reset does not depend on the stack having content");
});

test("the reset never wipes what the human just read: it keeps every entry from the last question on", () => {
	const entries = [
		{ sourceEntry: { id: "e1", type: "message", message: { role: "user" } } },
		{ sourceEntry: { id: "e2", type: "message", message: { role: "assistant" } } },
		{ sourceEntry: { id: "e3", type: "custom", customType: "finisher-state" } },
		{ sourceEntry: { id: "e4", type: "message", message: { role: "user" } } },
		{ sourceEntry: { id: "e5", type: "message", message: { role: "toolResult" } } },
		{ sourceEntry: { id: "e6", type: "message", message: { role: "assistant" } } },
	];
	assert.equal(lastUserEntryId(entries), "e4", "the question and the report answering it stay; only the noisy middle is summarized");
	const kept = freshCompactionEntry("carry this", lastUserEntryId(entries));
	assert.equal(kept.firstKeptEntryId, "e4", "the compaction keeps the tail instead of retaining nothing");
	assert.equal(kept.summary, "carry this");
	assert.equal(lastUserEntryId(entries.slice(0, 2)), "e1", "an assistant-only tail still keeps the question it answered");
	assert.equal(lastUserEntryId([]), null, "with no user message the compaction keeps nothing");
	assert.equal(lastUserEntryId([{ sourceEntry: { id: "x", type: "message", message: { role: "user" } } }, {}]), "x", "an entry without a source is skipped, not fatal");
	assert.equal(freshCompactionEntry("x").firstKeptEntryId, null, "the default stays retain-none");
});

test("the settle hook no longer compacts a plain answer, and a closed goal resets once with the human's tail kept", async () => {
	const ext = (await import("../extensions/finisher/index.ts")).default;
	const hooks = new Map();
	const pi = {
		on: (name, fn) => {
			hooks.set(name, fn);
			return () => {};
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerVirtualModel: () => {},
		appendEntry: () => {},
	};
	const saved = process.env.PI_FINISHER_SUBAGENT;
	process.env.PI_FINISHER_SUBAGENT = "0";
	try {
		ext(pi);
	} finally {
		if (saved === undefined) delete process.env.PI_FINISHER_SUBAGENT;
		else process.env.PI_FINISHER_SUBAGENT = saved;
	}
	const cwd = tmpRepo();
	const base = { phase: "requirements", turnsUsed: 1, tokensUsed: 10, escalations: [], trajectoryFlags: [], subagentRuns: [] };
	const session = (state) => ({
		cwd,
		mode: "rpc",
		hasUI: false,
		ui: { notify: () => {}, setWidget: () => {} },
		sessionManager: { getEntries: () => [{ type: "custom", customType: "finisher-state", data: state }] },
	});
	const settle = (contextEntries, ctx) => hooks.get("agent_before_settle")({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false, context: { contextEntries } }, ctx);
	const entries = [
		{ sourceEntry: { id: "u1", type: "message", message: { role: "user" } } },
		{ sourceEntry: { id: "a1", type: "message", message: { role: "assistant" } } },
	];

	const chat = session(base);
	await hooks.get("session_start")({}, chat);
	assert.equal(await settle(entries, chat), undefined, "asking the agent a question and getting an answer must not compact the transcript");

	const closed = { ...base, goalDriver: { goal: "ship it", confirmedAt: 1_000, attempts: { rounds: 1 }, doneAt: 5_000, outcome: "verified" } };
	const first = session(closed);
	await hooks.get("session_start")({}, first);
	const reset = await settle(entries, first);
	assert.equal(reset.entries.length, 1, "the run that closes the goal is a boundary");
	assert.equal(reset.entries[0].type, "compaction");
	assert.equal(reset.entries[0].firstKeptEntryId, "u1", "the question and the report answering it stay on screen");

	const later = session({ ...closed, freshResetAt: 0, freshResetGoalAt: 5_000 });
	await hooks.get("session_start")({}, later);
	assert.equal(await settle(entries, later), undefined, "that boundary was already paid for, so the next reply is left alone");
});
