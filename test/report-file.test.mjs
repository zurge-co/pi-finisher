import { finisherDir, writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_MAX_BYTES, capReport, currentReport, liveReport, readReportFile, reportMetaFromFile, reportPath, writeReportFile } from "../extensions/finisher/index.ts";

const freshCwd = () => mkdtempSync(join(tmpdir(), "finisher-report-"));

const input = (body, over = {}) => ({ goal: "ship the race HUD", outcome: "verified", at: 1_700_000_000_000, laps: 3, round: 2, body, ...over });

test("a written report always leads with its result and never grows past its byte ceiling", () => {
	const bodies = ["the whole run, short", "x".repeat(300 * 1024), "บรรทัดภาษาไทยที่ยาว\n".repeat(20_000), ""];
	for (const body of bodies) {
		const cwd = freshCwd();
		const meta = writeReportFile(cwd, input(body));
		assert.ok(meta, "a fresh cwd with no state dir still gets its report");
		assert.equal(meta.path, reportPath(cwd), "the report lands in the state dir");
		assert.ok(existsSync(finisherDir(cwd)), "the directory is created, not required to exist");
		const text = readReportFile(meta.path);
		assert.equal(meta.bytes, statSync(meta.path).size, "the byte count is the file on disk");
		assert.ok(Buffer.byteLength(text, "utf8") <= REPORT_MAX_BYTES, `a body of ${body.length} chars still fits the ceiling`);
		assert.match(text, /^# finisher report — verified\n/, "the result is the first line, never truncated away");
		assert.match(text, /goal: ship the race HUD/);
		assert.match(text, /laps: 3 · round: 2/);
		assert.match(text, /written: 2023-11-14T22:13:20.000Z/);
		if (Buffer.byteLength(body, "utf8") < REPORT_MAX_BYTES / 2) assert.ok(text.endsWith(body), "a body that fits is kept verbatim");
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("capReport is the identity under the ceiling and never exceeds it above, whatever the byte boundary falls on", () => {
	for (const text of ["", "abc", "ไทย".repeat(400), "x".repeat(50_000), "🙂".repeat(3_000)]) {
		for (const max of [0, 1, 7, 64, 100, 501, 4_096, REPORT_MAX_BYTES]) {
			const out = capReport(text, max);
			assert.ok(Buffer.byteLength(out, "utf8") <= max, `cap ${max} on ${text.length} chars: ${Buffer.byteLength(out, "utf8")} bytes`);
			if (Buffer.byteLength(text, "utf8") <= max) assert.equal(out, text, "under the ceiling nothing changes at all");
		}
	}
	assert.ok(capReport(`HEAD\n${"x".repeat(1_000_000)}`, 1_000).startsWith("HEAD"), "the head is what survives a cut");
});

test("the report on disk is the source of truth: no meta still shows it, and a stale meta never invents one", () => {
	const cwd = freshCwd();
	assert.equal(currentReport(cwd), undefined, "nothing written yet reads as no report");
	assert.equal(currentReport(undefined), undefined, "no cwd, no discovery");
	const meta = writeReportFile(cwd, input("body"));
	const found = reportMetaFromFile(cwd);
	assert.equal(found.path, meta.path);
	assert.equal(found.outcome, "verified");
	assert.equal(found.laps, 3, "the lap count survives the file head");
	assert.equal(found.at, 1_700_000_000_000, "the written stamp round-trips exactly");
	assert.equal(found.goal, "ship the race HUD");
	assert.deepEqual(currentReport(cwd), { outcome: "verified", laps: 3, at: 1_700_000_000_000, goal: "ship the race HUD" }, "the file alone is enough to offer the report");
	assert.deepEqual(currentReport(cwd, meta), liveReport(meta), "a live meta and the disk answer the same");
	rmSync(meta.path);
	assert.equal(currentReport(cwd, meta), undefined, "a stale meta is not a report once the file is gone");
	writeState(cwd, "report.md", "# some other file\n");
	assert.equal(currentReport(cwd), undefined, "a file that is not a finisher report advertises nothing");
	rmSync(cwd, { recursive: true, force: true });
});

test("liveReport is the row while the report file is there and nothing once it is gone", () => {
	const cwd = freshCwd();
	const meta = writeReportFile(cwd, input("body"));
	assert.deepEqual(liveReport(meta), { outcome: "verified", laps: 3, at: 1_700_000_000_000, goal: "ship the race HUD" });
	assert.equal(liveReport(undefined), undefined, "no report recorded reads as no report");
	rmSync(meta.path);
	assert.equal(liveReport(meta), undefined, "a deleted report stops advertising itself");
	assert.equal(readReportFile(meta.path), undefined, "and reading it is a plain nothing, not a throw");
	assert.equal(readReportFile(join(cwd, "never-written.md")), undefined);
	rmSync(cwd, { recursive: true, force: true });
});
