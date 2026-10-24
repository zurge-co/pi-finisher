import { type State } from "./types.ts";

export interface StateBox {
	get: () => State;
	set: (s: State) => void;
}

export const createStateBox = (initial: State): StateBox => {
	const current = initial;
	return {
		get: () => current,
		set: (s) => {
			const writable = current as unknown as Record<string, unknown>;
			for (const key of Object.keys(writable)) if (!(key in s)) delete writable[key];
			Object.assign(current, s);
		},
	};
};
