// zense-harness module: terminal-input ESC guard so zense dialogs close instead of aborting the agent (moved verbatim from index.ts — see AGENTS.md map)
//
// 2026-10-14 — peek: every zense dialog is an overlay floating over the transcript, and while
// it owns focus pi's fullscreen keybindings (PageUp/PageDown/wheel) refuse to scroll the
// transcript behind it (pi defers viewport input to a focused overlay on purpose). The only
// escape was Esc = close/skip, so the question was lost just to re-read the chat. The guard
// now mirrors the top dialog's overlay handle: pressing space (only when the dialog opts in
// via canPeek — a picker with text in its filter keeps space for typing) hides the overlay so
// the transcript scrolls normally; space/Esc brings it straight back, question intact, and
// every other key is swallowed while hidden so nothing leaks into the editor.

import { Key, matchesKey } from "@earendil-works/pi-tui";

// ----------------------------------------------------------------------------- esc-guard (module scope — exported for unit tests)

export type EscGuardHandler = (data: string) => { consume?: boolean } | undefined;
export interface EscGuardHandle { close: () => void }

/** Per-dialog registration: close = its cancel path; setHidden mirrors the overlay handle
 *  (pi's OverlayHandle.setHidden); canPeek lets a dialog keep its own space semantics (e.g. a
 *  picker with a non-empty filter must keep space for typing, a checkbox dialog toggles with
 *  space) — returning false means "space is taken, don't peek". Absent = peek allowed. */
export interface EscGuardEntry {
	close: () => void;
	setHidden?: (hidden: boolean) => void;
	canPeek?: () => boolean;
}

/** B (ESC): global input guard for zense dialogs — pi delivers keys only to the focused
 *  component; if focus slips off the overlay (e.g. while the agent streams), ESC lands in the
 *  main editor → onEscape aborts the agent's answer instead of closing the dialog. This guard
 *  sits at terminal-input level (before any component) via ctx.ui.onTerminalInput: every zense
 *  dialog registers itself onto a stack on open and unregisters on close — while the stack is
 *  non-empty ESC is consumed and closes the topmost dialog with its original semantics
 *  (done(null)); other keys pass through. With no dialog open the guard always returns
 *  undefined (never touches system keys). */
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
	// peeking with no dialog left (closed by another path, e.g. an abort signal) → drop it and
	// make sure whatever is now on top is visible again
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
					if (peeking && top() !== entry) endPeek(); // the peeked dialog went away underneath us
				},
			};
		},
		/** Flip peek on the topmost dialog: hidden (true) ↔ shown (false). undefined when no
		 *  dialog is open or the top dialog declined peek (space is its own key). */
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
			if (!stack.length) return undefined; // no dialog open → consume nothing
			if (peeking) {
				// hidden: only space/Esc bring the dialog back; everything else is swallowed so
				// the reader can't type into the editor (or abort the agent) while reading
				if (isPeekKey(data) || isEsc(data)) endPeek();
				return { consume: true };
			}
			if (isPeekKey(data) && top()?.canPeek?.() !== false) {
				top()!.setHidden?.(true);
				peeking = true;
				return { consume: true };
			}
			if (isEsc(data)) {
				top().close(); // close the topmost — the dialog unregisters itself via handle.close()
				return { consume: true };  // the key reaches no other component, incl. the main editor (no abort)
			}
			return undefined; // every other key goes to the focused component as usual
		},
		isPeeking: () => peeking,
		reset: () => { stack.length = 0; peeking = false; }, // new session: old overlays were popped by pi — drop stale entries
		depth: () => stack.length,
	};
};
