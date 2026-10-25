import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HANDOFF_KEY,
	parseHandoffResult,
	readHandoffModel,
	routeHandoffModel,
	splitHandoffPattern,
	withoutHandoffKey,
	handoffRouteNote,
	HANDOFF_ASK_PROMPT,
} from "../extensions/finisher/index.ts";
import { ladderPatterns } from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-handoff-model-"));

const writeJson = (cwd, file, cfg) => {
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", file), JSON.stringify(cfg));
};

test("the handoff slot is read from models.json first, then config.json", () => {
	const cwd = tmpRepo();
	assert.equal(readHandoffModel(cwd), undefined, "unset by default");
	writeJson(cwd, "config.json", { handoff: "openai/gpt-5-mini" });
	assert.deepEqual(readHandoffModel(cwd), { pattern: "openai/gpt-5-mini", provider: "openai", id: "gpt-5-mini", source: "config.json" });
	writeJson(cwd, "models.json", { handoff: "synthetic/hf:openai/gpt-oss-120b" });
	const m = readHandoffModel(cwd);
	assert.equal(m.source, "models.json", "models.json wins so the ladder file stays one place");
	assert.equal(m.provider, "synthetic");
	assert.equal(m.id, "hf:openai/gpt-oss-120b");
});

test("a malformed handoff value is ignored instead of crashing the run", () => {
	const cwd = tmpRepo();
	for (const bad of ["", "   ", "nomodel", "/leading", "trailing/"]) writeJson(cwd, "models.json", { handoff: bad });
	assert.equal(readHandoffModel(cwd), undefined);
	writeJson(cwd, "models.json", { handoff: 42 });
	assert.equal(readHandoffModel(cwd), undefined);
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "models.json"), "{not json");
	assert.equal(readHandoffModel(cwd), undefined, "a corrupt file must not break a sub-agent run");
});

test("the handoff slot is never counted as a fan-out rung", () => {
	const cfg = { priority1: "a/one", priority2: "b/two", handoff: "c/three" };
	assert.deepEqual(ladderPatterns(cfg), ["a/one", "b/two"], "the handoff model must not be used for parallel work");
	assert.deepEqual(withoutHandoffKey(Object.keys(cfg)), ["priority1", "priority2"]);
});

test("a classifier in the slot uses classify(); a chat model in the slot is asked", () => {
	const classifier = routeHandoffModel({ pattern: "typesafe/jev-latest", provider: "typesafe", id: "jev-latest", source: "models.json" }, () => true);
	assert.deepEqual(classifier, { kind: "classifier", provider: "typesafe", id: "jev-latest" });
	const chat = routeHandoffModel({ pattern: "openai/gpt-5-mini", provider: "openai", id: "gpt-5-mini", source: "models.json" }, () => false);
	assert.deepEqual(chat, { kind: "chat", provider: "openai", id: "gpt-5-mini" });
	assert.match(handoffRouteNote(chat), /chat model/);
	assert.match(handoffRouteNote(classifier), /classifier/);
});

test("no configured slot routes to none — the caller then falls back to a pi classifier", () => {
	assert.deepEqual(routeHandoffModel(undefined, () => true), { kind: "none", why: "unset" });
	assert.match(handoffRouteNote({ kind: "none", why: "unset" }), /no model configured/);
});

test("the chat result is read from the first line, and anything else is not a result", () => {
	assert.deepEqual(parseHandoffResult("KEEP\nit changes what the next task does"), { keep: true, reason: "it changes what the next task does" });
	assert.deepEqual(parseHandoffResult("drop"), { keep: false, reason: "" });
	assert.equal(parseHandoffResult("maybe?"), undefined, "an ambiguous answer is not a keep");
	assert.equal(parseHandoffResult(""), undefined);
	assert.equal(parseHandoffResult("  \n  "), undefined);
});

test("the ask prompt forbids statistics and is bounded", () => {
	const p = HANDOFF_ASK_PROMPT("verifier", "x".repeat(10_000));
	assert.match(p, /KEEP or DROP/);
	assert.match(p, /DROP statistics/);
	assert.ok(p.length < 6_000, "the candidate is truncated so the ask stays cheap");
});

test("the pattern splitter keeps a provider with a nested model id intact", () => {
	assert.deepEqual(splitHandoffPattern("synthetic/hf:moonshotai/Kimi-K3"), { provider: "synthetic", id: "hf:moonshotai/Kimi-K3" });
	assert.equal(splitHandoffPattern("nope"), undefined);
	assert.equal(splitHandoffPattern("/x"), undefined);
	assert.equal(HANDOFF_KEY, "handoff");
});
