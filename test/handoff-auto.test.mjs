import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHandoffPlan, handoffPlanNote } from "../extensions/finisher/index.ts";

const noClassifiers = async () => [];
const oneClassifier = async () => [{ provider: "typesafe", id: "jev-latest" }];
const twoClassifiers = async () => [
	{ provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" },
	{ provider: "typesafe", id: "jev-latest" },
];

test("with no slot configured, an available classifier is detected and used without asking the user", async () => {
	const plan = await resolveHandoffPlan({ slot: undefined, isClassifier: () => true, availableClassifiers: oneClassifier });
	assert.deepEqual(plan, { kind: "classifier", provider: "typesafe", id: "jev-latest", source: "auto" });
	assert.match(handoffPlanNote(plan), /detected/);
});

test("no classifier at all means handoff turns itself off — quietly, not with a setup demand", async () => {
	const plan = await resolveHandoffPlan({ slot: undefined, isClassifier: () => false, availableClassifiers: noClassifiers });
	assert.deepEqual(plan, { kind: "off", why: "no-slot-and-no-classifier" });
	const note = handoffPlanNote(plan);
	assert.match(note, /handoff: off/);
	assert.ok(!/log in|login|API_KEY|credential|set up|classifier credential/i.test(note), `the note must not nag the user, got: ${note}`);
});

test("a registry that throws is treated as having no classifier, not as a crash", async () => {
	const plan = await resolveHandoffPlan({ slot: undefined, isClassifier: () => false, availableClassifiers: async () => Promise.reject(new Error("no auth")) });
	assert.deepEqual(plan, { kind: "off", why: "no-slot-and-no-classifier" });
});

test("the first available classifier wins, and the choice is deterministic", async () => {
	const a = await resolveHandoffPlan({ slot: undefined, isClassifier: () => true, availableClassifiers: twoClassifiers });
	const b = await resolveHandoffPlan({ slot: undefined, isClassifier: () => true, availableClassifiers: twoClassifiers });
	assert.deepEqual(a, b);
	assert.equal(a.kind === "classifier" ? a.provider : "", "cloudflare-workers-ai");
});

test("an explicit ladder slot always wins over auto-detection", async () => {
	let asked = false;
	const classifierSlot = await resolveHandoffPlan({
		slot: { pattern: "typesafe/jev-latest", provider: "typesafe", id: "jev-latest", source: "models.json" },
		isClassifier: () => true,
		availableClassifiers: async () => ((asked = true), []),
	});
	assert.deepEqual(classifierSlot, { kind: "classifier", provider: "typesafe", id: "jev-latest", source: "slot" });
	assert.equal(asked, false, "auto-detection must not run when the user already chose");

	const chatSlot = await resolveHandoffPlan({
		slot: { pattern: "openai/gpt-5-mini", provider: "openai", id: "gpt-5-mini", source: "models.json" },
		isClassifier: () => false,
		availableClassifiers: oneClassifier,
	});
	assert.deepEqual(chatSlot, { kind: "chat", provider: "openai", id: "gpt-5-mini", source: "slot" });
	assert.match(handoffPlanNote(chatSlot), /chat model/);
});

test("a slot pointing at a classifier is not downgraded to a chat ask", async () => {
	const plan = await resolveHandoffPlan({
		slot: { pattern: "typesafe/jev-latest", provider: "typesafe", id: "jev-latest", source: "config.json" },
		isClassifier: (p, i) => p === "typesafe" && i === "jev-latest",
		availableClassifiers: noClassifiers,
	});
	assert.equal(plan.kind, "classifier", "even with no auto-detected list, the explicit classifier slot is trusted");
});
