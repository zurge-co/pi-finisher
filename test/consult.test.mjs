import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSULT_MODES, DEFAULT_CONSULT_MODE, DEFAULT_TURN_INTENT, consultDirective, consultMode, consultOnly, createStateBox, consultModeFromJson, goalStartsRun, modeSwitchNote, noGoalNeededNote, readConsultMode, shouldClarify, turnIntent, worksTurn } from "../extensions/finisher/index.ts";
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

test("each mode names one intent, and only the shipped default leaves the decision to the model", () => {
	assert.equal(DEFAULT_CONSULT_MODE, "auto", "the shipped default is the decide mode");
	assert.equal(DEFAULT_TURN_INTENT, "decide");
	assert.deepEqual(
		CONSULT_MODES.map((mode) => [mode, turnIntent(mode)]),
		[
			["auto", "decide"],
			["always", "consult"],
			["off", "work"],
		],
		"every mode maps to exactly one intent",
	);
	assert.equal(turnIntent(undefined), "decide", "no config at all is the model deciding, never the harness forcing work");
	for (const raw of [null, "", "  ", 0, 42, {}, [], true, "nonsense", "DECIDE", " decide "])
		assert.equal(turnIntent(consultMode(raw)), "decide", `raw ${JSON.stringify(raw)} falls back to the model deciding`);
	assert.equal(turnIntent(consultMode("ALWAYS ")), "consult", "case and padding are not conventions the human must know");
	assert.equal(turnIntent(consultMode("OFF")), "work");
});

test("no word of the human's ever reaches the intent: every prompt yields the same intent for the same mode", () => {
	for (const mode of CONSULT_MODES) {
		const seen = new Set(PROMPTS.map(() => turnIntent(mode)));
		assert.equal(seen.size, 1, `${mode} decides the turn for all ${PROMPTS.length} prompts, not their wording`);
	}
	for (const prompt of PROMPTS) assert.ok(["decide", "work", "consult"].includes(turnIntent("auto")), `${JSON.stringify(prompt)} yields a total intent`);
});

test("only a forced conversation holds the run back, and start: true always releases it", () => {
	for (const intent of ["decide", "work", "consult", undefined])
		for (const start of [undefined, false, true]) {
			const held = intent === "consult" && start !== true;
			assert.equal(goalStartsRun(intent, start), !held, `goalStartsRun(${String(intent)}, ${String(start)})`);
			assert.equal(consultOnly(intent, start), held, `consultOnly(${String(intent)}, ${String(start)})`);
			assert.equal(worksTurn(intent, start), !held, `worksTurn(${String(intent)}, ${String(start)})`);
			assert.equal(shouldClarify(intent, start, true), !held, `shouldClarify(${String(intent)}, ${String(start)})`);
		}
	assert.equal(goalStartsRun(undefined), true, "an unset intent is the model deciding, so a run may start");
	assert.equal(goalStartsRun("decide"), true, "the decide turn calls goal like any work turn");
	assert.equal(goalStartsRun("consult"), false);
	assert.equal(goalStartsRun("work"), true);
});

test("clarify is bound to a run that is really starting, so a conversation is never asked target/observable/scope", () => {
	for (const intent of ["consult", "decide", "work", undefined])
		for (const start of [true, false])
			for (const available of [true, false])
				assert.equal(shouldClarify(intent, start, available), available && (start === true || intent !== "consult"), "a question exists only where a run does");
	assert.equal(shouldClarify("consult", false, true), false, "the consult turn is the case that produced the unwanted questions");
	assert.equal(shouldClarify("decide", false, true), true, "a decided work turn still gets its one understanding round");
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

test("a decide turn arms the goal by itself: the model's own decision is the run, and start belongs to the human", async () => {
	const decide = toolSession({ intent: "decide" });
	const started = await decide.run("goal", { goal: "silence the HUD ticker", cases: ["npm test exits 0"] });
	assert.equal(started.isError, undefined, "a decided work order needs no flag the human never said");
	assert.deepEqual(decide.asked.map((a) => a.goal), ["silence the HUD ticker"], "and still confirms exactly once");
	assert.equal(decide.box.get().goalDriver.goal, "silence the HUD ticker");
	assert.match(started.content[0].text, /goal|ตัดสิน/, "the answer says the model decided, not that the human forced it");

	const consult = toolSession({ intent: "consult" });
	const held = await consult.run("goal", { goal: "silence the HUD ticker", cases: ["npm test exits 0"] });
	assert.equal(held.details.outcome, "consult", "and the same call in a conversation is still refused");
	assert.deepEqual(consult.asked, [], "so the decision is the only thing that armed the run");
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

test("every tool gate reads the same rule: a conversation is held back only until a goal is open or the human says go", async () => {
	const { goalOpenFor } = await import("../extensions/finisher/index.ts");
	for (const goal of [undefined, { doneAt: undefined }, { doneAt: 0 }, { doneAt: 7 }])
		assert.equal(goalOpenFor(goal), Boolean(goal) && !goal.doneAt, `goalOpenFor(${JSON.stringify(goal)})`);
	assert.equal(goalOpenFor({ doneAt: 5 }), false, "a closed goal is not an open one");

	const consult = toolSession({ intent: "consult", lang: "th" });
	const idle = await consult.run("code", { subtasks: [{ id: "s1", instruction: "x", files: ["a.ts"] }, { id: "s2", instruction: "y", files: ["b.ts"] }] });
	assert.equal(idle.details.spawned, 0, "a conversation spawns no coder");
	assert.match(idle.content[0].text, /[\u0E00-\u0E7F]/, "the refusal is in the human's Thai");
	assert.match(idle.content[0].text, /start: true/, "and names the way out");

	for (const tool of ["lap", "verify"]) {
		const armed = toolSession({ intent: "consult" });
		armed.box.get().goalDriver = { goal: "g", confirmedAt: Date.now(), attempts: { rounds: 0, fingerprints: [], caseRounds: {} } };
		const opened = await armed.run(tool, tool === "verify" ? { cases: [] } : {});
		assert.doesNotMatch(opened.content[0].text, /start: true/, `${tool} with an open goal is real work, not a conversation note`);

		armed.box.get().goalDriver = { goal: "g", confirmedAt: Date.now(), attempts: { rounds: 0, fingerprints: [], caseRounds: {} }, doneAt: Date.now() };
		const closed = await armed.run(tool, tool === "verify" ? { cases: [] } : {});
		assert.match(closed.content[0].text, /start: true/, `${tool} after the goal closed falls back to the conversation note`);
	}
});
