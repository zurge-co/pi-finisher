import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LADDER_MODEL_ID,
	LADDER_PROVIDER,
	ladderFromConfig,
	ladderLabel,
	pickLadderPattern,
	registerLadderModel,
	ladderRoutable,
	splitPattern,
} from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "zense-ladder-"));

const writeModels = (cwd, cfg) => {
	mkdirSync(join(cwd, ".finisher"), { recursive: true });
	writeFileSync(join(cwd, ".finisher", "models.json"), JSON.stringify(cfg));
};

test("a pattern splits into provider/model, and a thinking suffix is recognised only when it is a real level", () => {
	assert.deepEqual(splitPattern("synthetic/hf:openai/gpt-oss-120b"), { provider: "synthetic", id: "hf:openai/gpt-oss-120b" });
	assert.deepEqual(splitPattern("anthropic/claude-opus-5:high"), { provider: "anthropic", id: "claude-opus-5", thinkingLevel: "high" });
	assert.deepEqual(splitPattern("openai/gpt-6:sol"), { provider: "openai", id: "gpt-6:sol" }, "an unknown suffix stays part of the model id");
	assert.equal(splitPattern("nomodel"), undefined);
	assert.equal(splitPattern(""), undefined);
	assert.equal(splitPattern("/x"), undefined);
});

test("a user turn takes the top rung, and a retry steps down instead of pinning the same failing model", () => {
	const ladder = ["a/one", "b/two", "c/three"];
	assert.deepEqual(pickLadderPattern(ladder, "user", 0), { pattern: "a/one", rung: 0 });
	assert.deepEqual(pickLadderPattern(ladder, "retry", 0), { pattern: "b/two", rung: 1 });
	assert.deepEqual(pickLadderPattern(ladder, "direct", 0), { pattern: "c/three", rung: 2 });
	assert.equal(pickLadderPattern([], "user", 0), undefined, "no ladder means no pick, so the caller can fall back");
});

test("a long continuation steps off the top rung — the expensive model is for new work, not tool follow-ups", () => {
	const ladder = ["big/model", "small/model"];
	assert.equal(pickLadderPattern(ladder, "continuation", 0)?.rung, 0);
	assert.equal(pickLadderPattern(ladder, "continuation", 40)?.rung, 1);
	assert.equal(pickLadderPattern(["only/model"], "continuation", 40)?.rung, 0, "a one-rung ladder never indexes out of range");
	assert.equal(pickLadderPattern(["only/model"], "retry", 0)?.rung, 0);
	assert.equal(pickLadderPattern(["only/model"], "direct", 0)?.rung, 0);
});

test("the ladder is read from the real config keys, and only the first five rungs count", () => {
	const cwd = tmpRepo();
	writeModels(cwd, { priority1: "a/1", priority2: "b/2", priority3: "a/1" });
	assert.deepEqual(ladderFromConfig(cwd), ["a/1", "b/2"], "duplicate rungs collapse");
	writeModels(cwd, { priority: ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6"] });
	assert.deepEqual(ladderFromConfig(cwd), ["a/1", "b/2", "c/3", "d/4", "e/5"], "a sixth rung is above the model-ladder bound");
	assert.deepEqual(ladderFromConfig(tmpRepo()), []);
});

test("the virtual model is registered even with no ladder, because it is the router that reports the missing ladder", () => {
	const registered = [];
	const empty = tmpRepo();
	assert.equal(ladderRoutable(ladderFromConfig(empty)), false, "nothing to route to yet");
	assert.equal(registerLadderModel({ register: (m) => registered.push(m), readLadder: () => ladderFromConfig(empty) }), true);
	assert.equal(registered.length, 1, "a dead picker entry is worse than an honest error at route time");
	const withLadder = tmpRepo();
	writeModels(withLadder, { priority1: "a/one" });
	assert.equal(ladderRoutable(ladderFromConfig(withLadder)), true);
	assert.equal(registerLadderModel({ register: (m) => registered.push(m), readLadder: () => ladderFromConfig(withLadder) }), true);
	assert.equal(registered[0].provider, LADDER_PROVIDER);
	assert.equal(registered[0].id, LADDER_MODEL_ID);
	assert.match(ladderLabel(["a/one"]), /finisher\/auto → a\/one/);
	assert.match(ladderLabel([]), /not registered/);
});

test("a continuation sticks to the model that already answered, so a tool follow-up never switches under the run", () => {
	const cwd = tmpRepo();
	writeModels(cwd, { priority1: "a/one", priority2: "b/two" });
	let def;
	registerLadderModel({ register: (m) => (def = m), readLadder: () => ladderFromConfig(cwd) });
	const find = (provider, id) => (provider === "b" && id === "two" ? { provider, id } : undefined);
	const routed = def.route({ reason: "continuation", previous: { model: { provider: "b", id: "two" } }, messages: [] }, { modelRegistry: { find } });
	assert.deepEqual(routed.model, { provider: "b", id: "two" }, "the previous physical model is kept");
	assert.equal(routed.thinkingLevel, "medium");
});

test("a user turn routes to a rung that actually resolves, and refuses loudly instead of silently mis-routing", () => {
	const cwd = tmpRepo();
	writeModels(cwd, { priority1: "a/one", priority2: "b/two" });
	let def;
	registerLadderModel({ register: (m) => (def = m), readLadder: () => ladderFromConfig(cwd) });
	const top = def.route({ reason: "user", messages: [] }, { modelRegistry: { find: (p, i) => (p === "a" && i === "one" ? { provider: p, id: i } : undefined) } });
	assert.deepEqual(top.model, { provider: "a", id: "one" });
	assert.throws(() => def.route({ reason: "user", messages: [] }, { modelRegistry: { find: () => undefined } }), /does not resolve/);
});

test("with no ladder configured the router falls back to the previous model rather than throwing mid-run", () => {
	const cwd = tmpRepo();
	let def;
	registerLadderModel({ register: (m) => (def = m), readLadder: () => ladderFromConfig(cwd) });
	const find = (provider, id) => (provider === "b" && id === "two" ? { provider, id } : undefined);
	const routed = def.route({ reason: "user", previous: { model: { provider: "b", id: "two" } }, messages: [] }, { modelRegistry: { find } });
	assert.deepEqual(routed.model, { provider: "b", id: "two" });
	assert.throws(() => def.route({ reason: "user", messages: [] }, { modelRegistry: { find } }), /no priority1\.\.priority5/);
});
