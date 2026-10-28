---
name: goal-intake
description: Confirm the goal with goal before the run starts, drafting the goal and its cases from the human's own words, and decide for yourself whether a message is a conversation or a work order. Use whenever a pi-finisher turn begins.
---

# Goal intake

The human's message **is** the goal. Confirm it with `goal` before the run starts.

Reading the code to understand the request is yours to decide, not the harness's: nothing counts your
calls and nothing refuses a `read` or a `grep`. What the harness does do is draft the goal and its cases
from the human's own words and put that draft in front of you, so the dialog is one keystroke away
instead of a guess.

The turn itself is yours to classify. A message that asks something is a conversation: answer it, and
no dialog opens. A message that orders work is a run: `goal` with `start: true`. Only an explicit
`consultMode: always` in `~/.pi/finisher/<project>/config.json` takes that decision away from you.

Nothing else has to be configured. It is on from install, in every session.

## Draft the goal and its cases from the human's own words

- The goal is the human's own first sentence, trimmed — never a paraphrase you invented.
- The cases are the human's own lines that follow it. Keep at most five. A case the human cannot
  find in their own message is a case they cannot weigh.
- Do not translate, do not sharpen, do not add a case for something the human never asked for.
- When the message is one line, the goal line is also its single case.
- A case the human alone can check is passed as `{ id, human: true, note }` — it is reported to them
  separately and never fails the run.

## When the human's own words are vague

Some messages are easy to misread: "make it faster", "clean this up", "ปรับปรุงหน่อย".
The risk is not that they lack detail, it is that you understood them differently than they meant.
So `goal` asks — once, before the dialog — only to check the two of you mean the same thing.

- At most 3 questions, one per gap it names: what you take the goal to mean (`meaning`), what the
  quality word they used means to them (`words`), the result they expect at the end (`outcome`).
- Never a question about how the work is done and never one about how far it reaches — that is the
  agent's decision, and asking it reads as an interview.
- Every question carries options to pick, and the last option is always "as I said is enough".
- Never a question that reading the code would answer.
- The answers are folded into the cases before the same confirm dialog opens, so the human weighs one
  sharpened case list and confirms once. There is no second round for the same goal.
- If they pick "as I said is enough", confirm their words and make the cases concrete in the first
  lap; an answer that cannot be checked is kept as a note, never dressed up as a case.

### Both dialogs speak the human's language

Pass `lang` with the tag the human writes in. Pass `chrome` for the confirm dialog (`title`, `header`,
`note`, `keys`, `keysLine`, `emptyGoal`) and `clarifyChrome` for the clarify round (`title`, `asIs`,
`later`, `note`) written in that same language. Anything you leave out falls back to **English** — never
to another language, so a Spanish reader is never handed Thai. A value that is empty, longer than 120
characters, or carries a newline or control character is dropped instead of shown, so keep each string
one line. The escape the human picks (`asIs`) is refused as an answer in every language, including the
one you supplied.

## The dialog happens once

The human confirms the goal and its cases in one dialog. After the confirmation there is no gate
between you and the result: pick the approach, prove the cases, and report once at the end.

- The same goal is never asked again — not when a lap closes, not when a verify round ends, not when
  the case list is refined. The cases are your plan; only the goal is the human's decision.
- A **changed** goal opens the dialog again, and only that does.
- A declined dialog or an unanswered one (the dialog has a deadline) starts nothing. Report it once
  and wait for the human; do not re-word the goal hoping it passes.

## Before the goal is confirmed

Call `goal` with the draft goal and the draft cases, then start the work. Exploration that
would have told you what the human wanted is paid for twice: once by you, once by the human reading
a plan built on a guess.
