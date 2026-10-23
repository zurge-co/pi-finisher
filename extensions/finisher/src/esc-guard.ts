
import { Key, matchesKey } from "@earendil-works/pi-tui";

export type EscGuardHandler = (data: string) => { consume?: boolean } | undefined;
export interface EscGuardHandle { close: () => void }

export interface EscGuardEntry {
	close: () => void;
	setHidden?: (hidden: boolean) => void;
	canPeek?: () => boolean;
}

export const createEscGuard = (): {
	open: (close: () => void, setHidden?: (hidden: boolean) => void, canPeek?: () => boolean) => EscGuardHandle;
	handleInput: EscGuardHandler;
	toggle: () => boolean | undefined;
	isPeeking: () => boolean;
	reset: () => void;
	depth: () => number;
} => {
	const stack: EscGuardEntry[] = [];
	let peeking = false;
	const top = () => stack[stack.length - 1];
	const isPeekKey = (data: string) => data === " " || matchesKey(data, Key.space);
	const isEsc = (data: string) => data === "\x1b" || matchesKey(data, Key.escape);
			const endPeek = () => {
		if (!peeking) return;
		peeking = false;
		top()?.setHidden?.(false);
	};
	return {
		open: (close, setHidden, canPeek) => {
			const entry: EscGuardEntry = { close, setHidden, canPeek };
			stack.push(entry);
			let alive = true;
			return {
				close: () => {
					if (!alive) return;
					alive = false;
					const i = stack.lastIndexOf(entry);
					if (i >= 0) stack.splice(i, 1);
					if (peeking && top() !== entry) endPeek(); 				},
			};
		},
				toggle: () => {
			const entry = top();
			if (!entry) return undefined;
			if (peeking) {
				endPeek();
				return false;
			}
			if (entry.canPeek && !entry.canPeek()) return undefined;
			peeking = true;
			entry.setHidden?.(true);
			return true;
		},
		handleInput: (data) => {
			if (!stack.length) return undefined; 			if (peeking) {
												if (isPeekKey(data) || isEsc(data)) endPeek();
				return { consume: true };
			}
			if (isPeekKey(data) && top()?.canPeek?.() !== false) {
				top()!.setHidden?.(true);
				peeking = true;
				return { consume: true };
			}
			if (isEsc(data)) {
				top().close(); 				return { consume: true };  			}
			return undefined; 		},
		isPeeking: () => peeking,
		reset: () => { stack.length = 0; peeking = false; },
		depth: () => stack.length,
	};
};
