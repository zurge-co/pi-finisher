import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFIER_PREFERENCE, classifyGateway, decideKeep, describeDecision, distillThenKeep, needsClassifierSetup, parsePreference, preferenceRefs, subagentDistillGateway } from "../extensions/zense-harness/index.ts";

const gateway = (prob, opts = {}) => ({
	available: async () => opts.model ?? { provider: "typesafe", id: "jev-latest" },
	classify: async () => opts.throws ? Promise.reject(new Error("boom")) : { answers: { keep: { type: "bool", probability: prob } }, stopReason: opts.stopReason ?? "stop" },
});

test("a classifier verdict decides the handoff, and a low probability drops the note", async () => {
	assert.equal((await decideKeep(gateway(0.92), { from: "swarm", text: "the merge refuses two slices on one path, so split by file" })).keep, true);
	const dropped = await decideKeep(gateway(0.04), { from: "swarm", text: "the merge refuses two slices on one path, so split by file" });
	assert.equal(dropped.keep, false);
	assert.equal(dropped.why, "classifier");
	assert.equal(dropped.probability, 0.04);
});

test("without a classifier NOTHING is carried — an unvetted note is dropped, never kept", async () => {
	const d = await decideKeep(undefined, { from: "grader", text: "npm test is the only proof the bound holds" });
	assert.deepEqual(d, { keep: false, why: "no-classifier" });
	const noModel = await decideKeep({ available: async () => undefined, classify: async () => undefined }, { from: "grader", text: "npm test is the only proof the bound holds" });
	assert.deepEqual(noModel, { keep: false, why: "no-classifier" });
	assert.match(describeDecision(noModel, "grader"), /no classifier with credentials/);
	assert.equal(needsClassifierSetup(noModel), true, "the human must be told to set one up");
});

test("a classifier that errors or times out drops the note too — it stays unvetted, and it says so", async () => {
	const errored = await decideKeep(gateway(0, { stopReason: "error" }), { from: "swarm", text: "a real lesson that matters for the next task" });
	assert.deepEqual(errored, { keep: false, why: "classifier-error" });
	const thrown = await decideKeep(gateway(0, { throws: true }), { from: "swarm", text: "a real lesson that matters for the next task" });
	assert.deepEqual(thrown, { keep: false, why: "classifier-error" });
	assert.match(describeDecision(thrown, "swarm"), /stays unvetted/);
	assert.equal(needsClassifierSetup(thrown), true);
});

test("a note too thin to matter is dropped before any model is called", async () => {
	let called = false;
	const spy = { available: async () => ((called = true), undefined), classify: async () => ((called = true), undefined) };
	assert.deepEqual(await decideKeep(spy, { from: "swarm", text: "12" }), { keep: false, why: "too-thin" });
	assert.equal(called, false, "no classifier call is spent on noise");
});

test("the classifier preference is a real ladder, and a bad pattern cannot crash the lookup", () => {
	assert.deepEqual(parsePreference("typesafe/jev-latest"), { provider: "typesafe", id: "jev-latest" });
	assert.equal(parsePreference("noprovider"), undefined);
	assert.equal(preferenceRefs().length, CLASSIFIER_PREFERENCE.length);
	assert.ok(preferenceRefs().every((r) => r.provider && r.id));
});

test("the gateway prefers the configured order and falls back to whatever classifier is actually available", async () => {
	const registry = {
		getAvailableOfType: async () => [{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" }],
		getModelOfType: () => ({ fake: true }),
		classify: async () => ({ answers: { keep: { type: "bool", probability: 0.9 } }, stopReason: "stop" }),
	};
	const gw = classifyGateway(registry);
	assert.deepEqual(await gw.available(CLASSIFIER_PREFERENCE), { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" }, "the first available classifier wins when the preference misses");
	const out = await gw.classify({ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" }, { text: "x" }, { keep: {} });
	assert.equal(out.answers.keep.probability, 0.9);
	assert.equal(classifyGateway(undefined), undefined);
});

test("a registry that throws on availability keeps nothing, and the task itself never breaks", async () => {
	const gw = classifyGateway({ getAvailableOfType: async () => Promise.reject(new Error("no auth")), getModelOfType: () => undefined, classify: async () => ({}) });
	assert.equal(await gw.available(CLASSIFIER_PREFERENCE), undefined);
	const d = await decideKeep(gw, { from: "swarm", text: "a real lesson that matters for the next task" });
	assert.equal(d.keep, false);
	assert.equal(d.why, "no-classifier");
});

test("distillation runs only for a note the classifier kept — a dropped note is never sent to a model", async () => {
	let calls = 0;
	const gw = { distill: async () => ((calls += 1), "one distilled line that matters") };
	assert.equal(await distillThenKeep(gw, { keep: false, why: "classifier", probability: 0.1 }, { from: "swarm", text: "raw", existing: [] }), undefined);
	assert.equal(calls, 0, "a dropped note must not spend a model call");
	assert.equal(await distillThenKeep(gw, { keep: true, why: "classifier", probability: 0.9 }, { from: "swarm", text: "raw", existing: [] }), "one distilled line that matters");
});

test("a note with no classifier verdict is dropped before distillation, so no distiller call is spent", async () => {
	let calls = 0;
	const gw = { distill: async () => ((calls += 1), "line") };
	assert.equal(await distillThenKeep(gw, { keep: false, why: "no-classifier" }, { from: "swarm", text: "raw lesson", existing: [] }), undefined);
	assert.equal(calls, 0);
	assert.equal(await distillThenKeep(undefined, { keep: true, why: "classifier", probability: 0.9 }, { from: "swarm", text: "raw lesson", existing: [] }), "raw lesson", "with no distiller an approved note is kept as-is");
	const failing = { distill: async () => Promise.reject(new Error("model down")) };
	assert.equal(await distillThenKeep(failing, { keep: true, why: "classifier", probability: 0.9 }, { from: "swarm", text: "raw lesson", existing: [] }), undefined);
});

test("the distiller sees what is already on the stack, so it cannot re-add a duplicate", async () => {
	let seen = "";
	const gw = { distill: async (p) => ((seen = p), "new line") };
	await distillThenKeep(gw, { keep: true, why: "classifier", probability: 0.9 }, { from: "swarm", text: "fresh candidate", existing: [{ at: 1, from: "swarm", text: "already learned this" }] });
	assert.match(seen, /already learned this/);
	assert.match(seen, /fresh candidate/);
});

test("a sub-agent distiller gateway reports failure as no line, so the caller can decide", async () => {
	const gw = subagentDistillGateway({ runSubagent: async () => ({ ok: true, output: "DROP" }), parse: (o) => (o === "DROP" ? undefined : o) });
	assert.equal(await gw.distill("p"), undefined);
	const good = subagentDistillGateway({ runSubagent: async () => ({ ok: false, output: "failed" }), parse: (o) => o });
	assert.equal(await good.distill("p"), undefined);
});
