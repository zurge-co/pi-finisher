import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FINISHER_HOME ??= mkdtempSync(join(tmpdir(), "finisher-test-home-"));
