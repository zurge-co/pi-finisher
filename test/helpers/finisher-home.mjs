import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finisherDir } from "../../extensions/finisher/src/project-dir.ts";

export { finisherDir };

process.env.FINISHER_HOME ??= mkdtempSync(join(tmpdir(), "finisher-test-home-"));

export const testFinisherHome = () => process.env.FINISHER_HOME;

export const stateDir = (cwd) => {
	const dir = finisherDir(cwd);
	mkdirSync(dir, { recursive: true });
	return dir;
};

export const stateFile = (cwd, ...parts) => join(finisherDir(cwd), ...parts);

export const writeState = (cwd, name, body) => {
	const path = stateFile(cwd, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
};
