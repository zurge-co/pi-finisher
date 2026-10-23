import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUILTIN_PROVIDER_IDS,
	PROVIDER_MISSING_RX,
	buildProviderMissingGuidance,
	diagnoseProviderMissing,
	providerIdOfModelPattern,
	usedProviderOf,
} from "../extensions/zense-harness/index.ts";

const mkTmp = () => mkdtempSync(join(tmpdir(), "zense-provdiag-"));

test("providerIdOfModelPattern / usedProviderOf: provider is everything before '/', no '/' = undefined", () => {
	assert.equal(providerIdOfModelPattern("synthetic/hf:x:free"), "synthetic");
	assert.equal(providerIdOfModelPattern("Anthropic/Claude-Sonnet"), "anthropic");
	assert.equal(providerIdOfModelPattern("sonnet:high"), undefined);
	assert.equal(providerIdOfModelPattern("/no-leading"), undefined);
	assert.equal(usedProviderOf("openai/gpt-4o"), "openai");
	assert.equal(usedProviderOf(undefined), undefined);
	assert.equal(usedProviderOf("noSlash"), undefined);
});





test("diagnoseProviderMissing: silent fallback (usedModel has a different provider) → provider-mismatch", () => {
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "...", usedModel: "openai/gpt-4o" });
	assert.equal(d?.kind, "provider-mismatch");
	assert.equal(d?.patternProvider, "synthetic");
});

test("diagnoseProviderMissing: ok run + provider matches the pattern → no heal", () => {
	assert.equal(diagnoseProviderMissing("synthetic/hf:x:free", { ok: true, output: "", usedModel: "synthetic/hf:x:free" }), undefined);
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "boom", usedModel: "synthetic/hf:x" }), undefined);
});

test("diagnoseProviderMissing: built-in provider skips the heal (wrong id/missing auth isn't bare-boot)", () => {
	assert.ok(BUILTIN_PROVIDER_IDS.has("anthropic"));
	assert.equal(diagnoseProviderMissing("anthropic/claude-55", { ok: true, output: "", usedModel: "openai/gpt-4o" }), undefined);
});

test("diagnoseProviderMissing: hard error with usedModel uncaptured → hard-missing per PROVIDER_MISSING_RX", () => {
	const out = "sub-agent exited code=1\nError: no models found matching 'synthetic/hf:x:free'\n";
	const d = diagnoseProviderMissing("synthetic/hf:x:free", { ok: false, output: out });
	assert.equal(d?.kind, "hard-missing");
		assert.ok(!PROVIDER_MISSING_RX.test("sub-agent exited code=143 signal=null (timeout SIGTERM)"));
	assert.equal(diagnoseProviderMissing("synthetic/hf:x", { ok: false, output: "sub-agent exited code=143 (TIMEOUT)" }), undefined);
		assert.equal(diagnoseProviderMissing(undefined, { ok: false, output: "no models found matching x" }), undefined);
	assert.equal(diagnoseProviderMissing("sonnet:high", { ok: false, output: "no models found matching x" }), undefined);
});

test("buildProviderMissingGuidance: names the provider, the role, and the two real fixes", () => {
	const g = buildProviderMissingGuidance("verifier", "synthetic");
	assert.match(g, /verifier/);
	assert.match(g, /synthetic/);
	assert.match(g, /install\/enable the extension/);
	assert.match(g, /pi login synthetic/);
	assert.ok(!g.includes("ext-config"), "the ext-config surface is gone, so guidance must not point at it");
});


test("buildProviderMissingGuidance: already included but falling back → points at auth; no hit → points at installing / changing the model", () => {
	const inc = buildProviderMissingGuidance("reviewer", "synthetic", {
		hit: { path: "/x/pkg/extensions/provider/index.ts", label: "provider/index.ts" },
		alreadyIncluded: true,
	});
	assert.ok(inc.includes("auth") && inc.includes("pi login synthetic"));
	assert.ok(!inc.includes("tick"), "already included → must not order another tick");
	const none = buildProviderMissingGuidance("grader", "acme-llm");
	assert.ok(none.includes("/zense models"), "no extension found → offer changing the role's model");
	assert.ok(!none.includes("ext-config-show grader on"), "no path = never orders on <path>");
});


