---
name: goal-intake
description: Confirm the goal with goal before exploring any code, drafting the goal and its cases from the human's own words. Use at the start of a pi-finisher run, before the first read, grep or bash call.
---

# Goal intake

The human's message **is** the goal. Confirm it with `goal` before you read, grep, or
explore anything. The harness allows two pre-goal calls to reach that dialog; after that every
exploration call is refused with a note that says so, and the only way forward is the dialog.

Nothing has to be configured for this. It is on from install, in every session.

## Draft the goal and its cases from the human's own words

- The goal is the human's own first sentence, trimmed — never a paraphrase you invented.
- The cases are the human's own lines that follow it. Keep at most five. A case the human cannot
  find in their own message is a case they cannot weigh.
- Do not translate, do not sharpen, do not add a case for something the human never asked for.
- When the message is one line, the goal line is also its single case.
- A case the human alone can check is passed as `{ id, human: true, note }` — it is reported to them
  separately and never fails the run.

## When the human's own words are vague

Some messages carry no checkable outcome: "make it faster", "clean this up", "ปรับปรุงหน่อย".
Reading more code cannot answer what they meant, so `goal` asks — once, before the dialog.

- At most 3 questions, one per gap it names: what should change (`target`), how the result is
  checked (`observable`), how far the change may reach (`scope`).
- Every question carries options to pick — drawn from the repo's own module and directory names where
  it can — and the last option is always "as I said is enough".
- Never a question that reading the code would answer: which file owns a behaviour is your job, what
  counts as done is theirs.
- The answers are folded into the cases before the same confirm dialog opens, so the human weighs one
  sharpened case list and confirms once. There is no second round for the same goal.
- If they pick "as I said is enough", confirm their words and make the cases concrete in the first
  lap; a clarifying answer that cannot be checked is kept as a note, never dressed up as a case.

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
