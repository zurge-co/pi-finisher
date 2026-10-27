import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSULT_MODES, consultDirective, consultMode, createStateBox, consultModeFromJson, goalStartsRun, noGoalNeededNote, readConsultMode, shouldClarify, turnIntent } from "../extensions/finisher/index.ts";
import { registerTools } from "../extensions/finisher/src/tools.ts";

const PROMPTS = [
	"ทำไม HUD ถึงกระพริบ",
	"คุณคิดว่าแบบไหนดีกว่ากัน",
	"should the panel tick on every write?",
	"what do you think about splitting the swarm module",
	"แก้บั๊กตอน logout ด้วย",
	"add a test for the report page",
	"อ่านโค้ดนี้ให้หน่อย",
	"",
];

test("the turn's intent is a function of the configured mode and of nothing else", () => {
	assert.equal(turnIntent("always"), "consult");
	assert.equal(turnIntent("off"), "work");
	assert.equal(turnIntent("auto"), "work", "auto is the model deciding, so the harness does not pre-empt it");
	assert.equal(turnIntent(undefined), "work");
});

test("no word of the human's ever reaches the intent: every prompt yields the same intent for the same mode", () => {
	for (const mode of CONSULT_MODES) {
		const seen = new Set(PROMPTS.map(() => turnIntent(mode)));
		assert.equal(seen.size, 1, `${mode} decides the turn for all ${PROMPTS.length} prompts, not their wording`);
	}
	for (const prompt of PROMPTS) assert.ok(["consult", "work"].includes(turnIntent("auto")), `${JSON.stringify(prompt)} yields a total intent`);
});

test("only a work turn ever starts a run, and consult never opens a dialog on its own", () => {
	for (const intent of ["consult", "work", undefined])
		for (const start of [undefined, false, true]) {
			assert.equal(goalStartsRun(intent, start), start === true || intent === "work", "start: true is the human saying go");
			assert.equal(goalStartsRun(intent, start) && intent === "consult" ? start === true : true, true, "consult alone never starts work");
		}
	assert.equal(goalStartsRun(undefined), false, "no intent is never a run");
	assert.equal(goalStartsRun("consult"), false);
	assert.equal(goalStartsRun("work"), true);
});

test("clarify is bound to a run that is really starting, so a conversation is never asked target/observable/scope", () => {
	for (const intent of ["consult", "work", undefined])
		for (const start of [true, false])
			for (const available of [true, false])
				assert.equal(shouldClarify(intent, start, available), available && goalStartsRun(intent, start), "a question exists only where a run does");
	assert.equal(shouldClarify("consult", false, true), false, "the consult turn is the case that produced the unwanted questions");
});

test("the configured mode is read defensively: an unknown value never disables or forces consultation", () => {
	for (const mode of CONSULT_MODES) assert.equal(consultMode(mode), mode);
	assert.equal(consultMode("ALWAYS"), "always", "case is not a convention the human has to know");
	assert.equal(consultMode("nonsense"), "auto");
	assert.equal(consultMode(undefined, "off"), "off");
	assert.equal(consultModeFromJson({ consultMode: "off" }), "off");
	assert.equal(consultModeFromJson(undefined), "auto");
	assert.equal(consultModeFromJson({ consultMode: 42 }), "auto");
	assert.equal(readConsultMode(process.cwd(), { FINISHER_CONSULT_MODE: "always" }), "always", "the env override wins over the file");
	assert.equal(readConsultMode(process.cwd(), { FINISHER_CONSULT_MODE: "bogus" }), "auto");
});

test("both notes are one line, name goal as the way out, and speak the human's language", () => {
	const thai = [consultDirective("ทำไมช้า", "th"), noGoalNeededNote("lap", "th")];
	const english = [consultDirective("why is it slow", "en"), noGoalNeededNote("lap", "en")];
	for (const note of thai) {
		assert.match(note, /[\u0E00-\u0E7F]/, "Thai must reach the Thai human");
		assert.ok(!note.includes("\n"), "a note is one painted line");
		assert.match(note, /goal/);
	}
	for (const note of english) {
		assert.doesNotMatch(note, /[\u0E00-\u0E7F]/, "English must not carry Thai");
		assert.match(note, /goal/);
	}
	assert.match(thai[1], /lap/, "the refusal names the tool it refused");
	assert.match(english[1], /lap/);
	assert.ok(consultDirective("", "en").length > 0, "a blank prompt still yields a directive");
});

const toolSession = (opts = {}) => {
	const defs = [];
	const box = createStateBox({ phase: "requirements", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const asked = [];
	const base = () => box.get();
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return base();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal, cases) => (asked.push({ goal, cases }), "confirmed"),
		askClarifyQuestion: async () => "as I said is enough",
	});
	box.get().turnIntent = opts.intent;
	box.get().humanLang = opts.lang ?? "en";
	const ctx = { hasUI: true, mode: "tui", cwd: opts.cwd ?? process.cwd(), ui: { notify: () => {}, confirm: async () => true }, sessionManager: { getEntries: () => [], getSessionId: () => "s1" } };
	const run = (name, params) => defs.find((d) => d.name === name).execute("c1", params, undefined, undefined, ctx);
	return { box, asked, run };
};

test("a consult turn's goal opens no dialog and starts no run, and start: true is the only way out", async () => {
	const consult = toolSession({ intent: "consult" });
	const refused = await consult.run("goal", { goal: "make the HUD calmer", cases: ["no flicker"] });
	assert.equal(refused.details.outcome, "consult", "the tool answers instead of starting a run");
	assert.deepEqual(consult.asked, [], "a conversation never puts a dialog on the screen");
	assert.equal(consult.box.get().goalDriver, undefined, "and nothing is armed");
	assert.match(refused.content[0].text, /start: true/, "the refusal names the one way to start work");

	const started = await consult.run("goal", { goal: "make the HUD calmer", cases: ["no flicker"], start: true });
	assert.equal(started.isError, undefined);
	assert.deepEqual(consult.asked.map((a) => a.goal), ["make the HUD calmer"], "start: true is the human saying go");
	assert.equal(consult.box.get().goalDriver.goal, "make the HUD calmer");

	const work = toolSession({ intent: "work" });
	await work.run("goal", { goal: "g", cases: ["c"] });
	assert.deepEqual(work.asked.map((a) => a.goal), ["g"], "a work turn still confirms before it runs");
	assert.equal(work.box.get().goalDriver.goal, "g");
});

test("lap and verify answer a conversation in the human's language instead of demanding a goal", async () => {
	for (const [tool, params] of [["lap", {}], ["verify", { cases: [] }]]) {
		const thai = toolSession({ intent: "consult", lang: "th" });
		const answer = await thai.run(tool, params);
		assert.equal(answer.isError, undefined, `${tool} is not an error in consult mode`);
		assert.match(answer.content[0].text, /[\u0E00-\u0E7F]/, `${tool} must answer in the human's Thai`);
		assert.match(answer.content[0].text, new RegExp(tool), `${tool} names itself`);
		assert.match(answer.content[0].text, /start: true/);
		assert.equal(thai.box.get().goalDriver, undefined, `${tool} invents no goal`);

		const english = toolSession({ intent: "consult", lang: "en" });
		const line = (await english.run(tool, params)).content[0].text;
		assert.doesNotMatch(line, /[\u0E00-\u0E7F]/);
		assert.equal(line.includes("\n"), false, "a note is one painted line");
	}
	const work = toolSession({ intent: "work" });
	assert.match((await work.run("lap", {})).content[0].text, /no goal is open — call goal first/, "a work turn still gets the honest refusal");
});
