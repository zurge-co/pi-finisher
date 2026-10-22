const m = await import("../../extensions/zense-harness/index.ts");
const py = "def test_law():\n    assert clamp(9,5,5) == 5\n\ndef test_filler():\n    pass\n";
const go = "func TestLaw(t *testing.T) {\n\tif x != 5 { t.Fatalf(1) }\n}\nfunc TestFiller(t *testing.T) {\n}\n";
const kinds = m.analyzeTestFile(py, "pkg/x_test.py").map((f) => f.kind);
const gb = m.testBlocksFor(go, "svc/x_test.go").length;
const gk = m.analyzeTestFile(go, "svc/x_test.go").map((f) => f.name);
const ok = kinds.length === 1 && kinds[0] === "no-assertion" && gb === 2 && gk.length === 1 && gk[0] === "TestFiller";
console.log(JSON.stringify({ kinds, gb, gk }));
process.exit(ok ? 0 : 1);
