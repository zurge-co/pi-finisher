import { type State } from "./types.ts";

export interface StateBox {
	get: () => State;
	set: (s: State) => void;
}

export const createStateBox = (initial: State): StateBox => {
	let current = initial;
	return {
		get: () => current,
		set: (s) => {
			current = s;
		},
	};
};
