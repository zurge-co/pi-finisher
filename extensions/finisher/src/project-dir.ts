import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const FINISHER_HOME_ENV = "FINISHER_HOME";
export const PROJECT_KEY_MAX = 60;
export const PROJECT_HASH_LEN = 8;
export const STATE_HOME_LABEL = "~/.pi/finisher/<project>";

export const finisherHome = (home = homedir()): string => {
	const env = process.env[FINISHER_HOME_ENV];
	if (typeof env === "string" && env.trim()) return resolve(env.trim());
	return join(home, ".pi", "finisher");
};

export const projectKey = (cwd: string): string => {
	const abs = resolve(String(cwd ?? "."));
	const flat = abs
		.split(sep)
		.filter(Boolean)
		.join("-")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const tail = flat.length > PROJECT_KEY_MAX ? flat.slice(-PROJECT_KEY_MAX) : flat;
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, PROJECT_HASH_LEN);
	return `${tail || "root"}-${hash}`;
};

export const finisherDir = (cwd: string): string => join(finisherHome(), projectKey(cwd));

export const statePath = (cwd: string, ...parts: string[]): string => join(finisherDir(cwd), ...parts);

export const shortHome = (abs: string, home = homedir()): string =>
	abs === home ? "~" : abs.startsWith(`${home}${sep}`) ? `~${abs.slice(home.length)}` : abs;

export const stateLabel = (cwd: string, ...parts: string[]): string => shortHome(statePath(cwd, ...parts));
