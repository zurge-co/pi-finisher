import { writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HANDOFF_LINE_MAX,
	HANDOFF_MAX_ITEMS,
	classifyKeep,
	condenseLine,
	handoffKeepProbability,
	isWorthKeeping,
	pushHandoff,
	clearOtherGoals,
	handoffPath,
	readHandoff,
	trimStack,
	writeHandoff,
	handoffInjection,
	stackSummary,
} from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-handoff-"));

test("a line never exceeds the cap, whatever whitespace or length the input has", () => {
	const inputs = ["", "   ", "x".repeat(5_000), "a b c ".repeat(2_000), "word\n\t\r  padded", "ก".repeat(HANDOFF_LINE_MAX * 3)];
	for (const raw of inputs) {
		const out = condenseLine(raw);
		assert.ok(out.length <= HANDOFF_LINE_MAX, `condenseLine(${raw.slice(0, 12)}…) → ${out.length} chars`);
		assert.ok(!/\s\s|\n|\t/.test(out), "no runs of whitespace survive");
	}
});

test("the keep decision is a threshold on probability, not a truthy read", () => {
	assert.equal(handoffKeepProbability({ type: "bool", probability: 0.51 }), 0.51);
	assert.equal(handoffKeepProbability(undefined), 0);
	assert.equal(handoffKeepProbability({ type: "choice", choice: "true", confidence: 0.2 }), 0.2);
	assert.equal(classifyKeep({ probability: 0.5 }), true, "exactly at the threshold keeps");
	assert.equal(classifyKeep({ probability: 0.49 }), false, "just under the threshold drops");
	assert.equal(classifyKeep(undefined), false);
});

test("statistics and restatements can never enter the stack, only knowledge does", () => {
	assert.equal(isWorthKeeping("12"), false);
	assert.equal(isWorthKeeping("87.5%"), false);
	assert.equal(isWorthKeeping("done"), false);
	assert.equal(isWorthKeeping("short"), false);
	assert.equal(isWorthKeeping("the merge refuses overlapping paths, so split by file"), true);
});

test("the stack has a hard cap and the newest insight always survives it", () => {
	let items = [];
	for (let i = 0; i < HANDOFF_MAX_ITEMS * 3; i++) items = pushHandoff(items, { at: i, from: "swarm", text: `insight number ${i} about the scheduler bound` });
	assert.equal(items.length, HANDOFF_MAX_ITEMS);
	assert.equal(items.at(-1).text, `insight number ${HANDOFF_MAX_ITEMS * 3 - 1} about the scheduler bound`);
	assert.equal(trimStack(items, 3).length, 3);
	assert.equal(trimStack(items, 3).at(-1), items.at(-1), "trimming keeps the tail, never the head");
});

test("a repeated insight is stored once — the stack cannot grow by paraphrase-free repetition", () => {
	let items = pushHandoff([], { at: 1, from: "swarm", text: "worktree merges refuse overlapping file paths" });
	items = pushHandoff(items, { at: 2, from: "grader", text: "  worktree merges refuse   overlapping file paths " });
	assert.equal(items.length, 1);
});

test("what a real sub-agent writes is what the next task reads back", () => {
	const cwd = tmpRepo();
	const long =
		"the RPC sub-agent needs --no-extensions or it reloads the harness and spawns itself recursively, which is why every role boots bare";
	writeHandoff(cwd, []);
	const after = pushHandoff(readHandoff(cwd), { at: 10, from: "swarm", text: long });
	writeHandoff(cwd, after);
	const back = readHandoff(cwd);
	assert.equal(back.length, 1);
	assert.equal(back[0].from, "swarm");
	assert.ok(back[0].text.length <= HANDOFF_LINE_MAX);
	assert.match(handoffInjection(back) ?? "", /recursively/);
});

test("an empty stack never creates the file, and clearing an existing one empties it in place", () => {
	const cwd = tmpRepo();
	writeHandoff(cwd, []);
	assert.equal(existsSync(handoffPath(cwd)), false, "writing nothing creates nothing");
	assert.deepEqual(clearOtherGoals(cwd, "a brand new goal"), []);
	assert.equal(existsSync(handoffPath(cwd)), false, "the parked goal flow never creates handoff.jsonl");
	writeHandoff(cwd, [{ at: 1, from: "swarm", text: "a lesson worth keeping past one task boundary" }]);
	assert.equal(existsSync(handoffPath(cwd)), true);
	writeHandoff(cwd, []);
	assert.equal(existsSync(handoffPath(cwd)), true, "an existing stack is emptied in place, not deleted");
	assert.deepEqual(readHandoff(cwd), []);
});

test("a corrupt stack file yields an empty stack instead of throwing the run away", () => {
	const cwd = tmpRepo();
	writeState(cwd, "handoff.jsonl", '{not json\n\n[]\n{"text":""}\n');
	assert.deepEqual(readHandoff(cwd), []);
});


test("the injection lists the tail of the stack, capped, so it cannot blow the prompt budget", () => {
	const items = Array.from({ length: HANDOFF_MAX_ITEMS }, (_, i) => ({ at: i, from: "swarm", text: `lesson ${i} that matters for the next task` }));
	const body = stackSummary(items, 3).split("\n");
	assert.equal(body.length, 3);
	assert.deepEqual(body, ["- lesson 9 that matters for the next task", "- lesson 10 that matters for the next task", "- lesson 11 that matters for the next task"]);
	assert.equal(handoffInjection([]), undefined);
});
