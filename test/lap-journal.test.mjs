import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendRecord,
	doneRecord,
	gapRecord,
	journalEnabled,
	journalPath,
	parseJournal,
	readJournal,
	summarizeGaps,
	summaryLines,
	themeOf,
	globalFinisherDir,
} from "../extensions/finisher/index.ts";

const gap = (extra = {}) =>
	gapRecord({
		repo: "/repo/one",
		goal: "ship the race HUD",
		round: 1,
		lap: 4,
		laps: 5,
		added: ["fix c1 FAIL — `node probe.mjs` exited 1"],
		cases: [{ id: "c1", verdict: "FAIL", reason: "`node probe.mjs` exited 1" }],
		models: ["p/m", "p/m"],
		...extra,
	});

test("the journal lives in the global home, not in the repo, and one record is one JSON line", () => {
	const home = mkdtempSync(join(tmpdir(), "finisher-home-"));
	assert.equal(globalFinisherDir(home), join(home, ".pi", "finisher"));
	assert.equal(journalPath(home), join(home, ".pi", "finisher", "laps.jsonl"));
	const path = journalPath(home);
	assert.equal(appendRecord(path, gap()), true);
	assert.equal(appendRecord(path, doneRecord({ repo: "/repo/one", goal: "ship the race HUD", rounds: 2, laps: 6, outcome: "verified" })), true);
	const lines = readFileSync(path, "utf8").trim().split("\n");
	assert.equal(lines.length, 2, "one line per event, so a tail -f or a script can read it");
	const back = parseJournal(readFileSync(path, "utf8"));
	assert.deepEqual(back.map((r) => r.kind), ["gap", "done"]);
	assert.deepEqual(back[0].models, ["p/m"], "the model list is deduped");
	assert.equal(back[1].outcome, "verified");
	assert.deepEqual(readJournal(home).length, 2, "reading the home journal finds them");
	assert.deepEqual(readJournal(mkdtempSync(join(tmpdir(), "finisher-empty-"))), [], "no journal is an empty history, not a crash");
});

test("a record is bounded and carries no file contents, so the journal stays small and safe to share", () => {
	const long = gap({
		goal: "g".repeat(2_000),
		repo: "/r".repeat(500),
		added: Array.from({ length: 40 }, (_, i) => `lap ${i}`),
		cases: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, verdict: "FAIL", reason: "x".repeat(2_000) })),
		models: Array.from({ length: 20 }, (_, i) => `m/${i}`),
	});
	const json = JSON.stringify(long);
	assert.ok(json.length < 20_000, `a single record must stay small, got ${json.length}`);
	assert.ok(long.goal.length <= 240, "the goal is clipped");
	assert.equal(long.added.length, 12, "at most a dozen added laps are kept");
	assert.equal(long.cases.length, 24, "at most two dozen cases are kept");
	assert.ok((long.cases[0].reason ?? "").length <= 300, "a reason is clipped");
	assert.equal(long.models?.length, 8, "the model list is capped");
});

test("junk lines are skipped and only real records count, so a truncated write cannot poison the digest", () => {
	const text = ['{"kind":"gap","at":1,"repo":"r","goal":"g","round":1,"lap":2,"laps":3,"added":[],"cases":[]}', "not json", '{"kind":"other"}', '{"kind":"gap"' , '{"kind":"done","at":2,"repo":"r","goal":"g","rounds":1,"laps":3,"outcome":"verified"}'].join("\n");
	assert.deepEqual(parseJournal(text).map((r) => r.kind), ["gap", "done"]);
});

test("the digest names why laps were added: themes over every case, ranked, with the repeat reason", () => {
	const records = [
		gap({ cases: [{ id: "c1", verdict: "FAIL", reason: "`npm test` exited 1" }, { id: "c2", verdict: "UNVERIFIED", reason: "no command was run — a claim without executed evidence proves nothing" }] }),
		gap({ cases: [{ id: "c3", verdict: "UNVERIFIED", reason: "no command was run — a claim without executed evidence proves nothing" }] }),
		gap({ cases: [{ id: "c4", verdict: "BLOCKED", reason: "the verifier never produced a verdict — sub-agent rpc error" }] }),
		doneRecord({ repo: "/repo/one", goal: "ship the race HUD", rounds: 2, laps: 6, outcome: "halted" }),
	];
	const summary = summarizeGaps(records);
	assert.equal(summary.gaps, 3);
	assert.equal(summary.extraLaps, 3);
	assert.equal(summary.themes[0][0], "unproven (no command)", "the commonest gap is ranked first");
	assert.equal(summary.themes[0][1], 2);
	assert.equal(summary.topMissing[0][1], 2, "the repeated reason is counted, not just listed");
	const lines = summaryLines(summary).join("\n");
	assert.match(lines, /3 gap\(s\) across 1 goal\(s\) → 3 extra lap\(s\)/);
	assert.match(lines, /most repeated reason:/);
	assert.deepEqual(summaryLines(summarizeGaps([])), ["no extra lap has been needed yet — nothing to analyse"]);
});

test("every gap reason lands on a theme, so nothing is silently uncounted", () => {
	const cases = [
		["no command was run — a claim", "unproven (no command)"],
		["the verifier could not exercise the change directly", "unproven (cannot exercise)"],
		["the check never produced output — TIMEOUT 600s", "unrunnable check"],
		["the harness never recorded `npm test` running — a case with no executed command is not proven", "unproven (no command)"],
		["the verdict says PASS but `x` exited 1 — the report contradicts itself", "contradiction"],
		["the run changed the working tree while proving it", "wrote the repo while proving it"],
		["`node probe.mjs` exited 1", "real failure"],
		["something new", "other"],
		[undefined, "no reason given"],
	];
	for (const [reason, theme] of cases) assert.equal(themeOf(reason), theme, `${reason} → ${theme}`);
});

test("the journal can be switched off entirely, for a machine that must not keep history", () => {
	assert.equal(journalEnabled({}), true);
	assert.equal(journalEnabled({ FINISHER_NO_JOURNAL: "1" }), false);
	assert.equal(journalEnabled({ FINISHER_NO_JOURNAL: "0" }), true);
});

test("a record that is only half there is skipped, so a foreign or hand-edited line cannot kill the digest", () => {
	const lines = [
		'{"kind":"gap","at":1,"repo":"r","goal":"g","round":1,"lap":2,"laps":3,"added":[],"cases":[]}',
		'{"kind":"gap"}',
		'{"kind":"gap","at":2,"goal":"g"}',
		'{"kind":"gap","at":3,"repo":"r","goal":"g","round":1,"lap":2,"laps":3,"added":"not-an-array","cases":[]}',
		'{"kind":"gap","at":4,"repo":"r","goal":"g","round":1,"lap":2,"laps":3,"added":[],"cases":[{"id":5,"verdict":null}]}',
		'{"kind":"done","at":5,"repo":"r","goal":"g","rounds":1,"laps":3,"outcome":"verified"}',
		'{"kind":"done"}',
	];
	const records = parseJournal(lines.join("\n"));
	assert.deepEqual(records.map((r) => r.kind), ["gap", "done"], "only the two complete records survive");
	const summary = summarizeGaps(records);
	assert.equal(summary.gaps, 1);
	assert.equal(summary.extraLaps, 0);
	assert.doesNotThrow(() => summaryLines(summary), "the digest of a partly foreign history still renders");
	assert.equal(summarizeGaps([{ kind: "gap", at: 1, repo: "r", goal: "g", round: 1, lap: 1, laps: 1, added: undefined, cases: undefined }]).gaps, 1, "and it tolerates a record built by hand without its arrays");
});
