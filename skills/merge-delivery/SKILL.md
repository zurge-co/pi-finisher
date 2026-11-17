---
name: merge-delivery
description: Merge a pi-finisher delivery worktree into the current branch when the human says merge, lgtm or เอาเลย, then delete the worktree and its branch. Use whenever the human approves work that a code fan-out delivered.
---

# What a delivery worktree holds

`code` never touches the branch you are sitting on. It commits the whole fan-out into one checkout on
branch `finisher/swarm/<runId>` and records it in `~/.pi/finisher/<project>/delivery.json` —
`{ runId, branch, worktreeDir, baseHead, at, applied }`. That file, not your memory, names the branch:
read it before anything else, and treat a missing file as "there is no delivery to merge".

`verify` already ran its checks and its commands with that checkout as the working directory. The
workspace was green against it, not against its own tree.

## The human's word is the trigger

- "merge เลยครับ", "merge it", "lgtm", "ship it", "เอาเลย", "ok merge" — an approval **is** the merge
  order. Do not ask them to spell the commands out, and do not make them say it twice.
- Anything that is not an approval ("looks ok but…", a question about the diff, a remark about the
  goal) never merges anything.
- No approval yet means the work stays where it is. A delivery waiting is not a mistake.

## The gates, before a single commit lands

Each gate is a command whose output you actually read.

1. **The workspace is clean.** `git status --porcelain` must print nothing. A dirty tree has no room
   for a merge: say what is dirty and stop.
2. **The base has not moved.** `git rev-parse HEAD` must equal `baseHead` from delivery.json. If it
   moved, the work was written against an older tree: `git -C <worktreeDir> rebase <the new HEAD>`,
   re-run the checks in that checkout, and only then merge. Never merge blind over a moved base.
3. **The delivery is green.** A report of `verified` on that branch is the approval to merge; a
   `needs-human` or `halted` report is not, whatever the human typed.
4. **The checkout is really there.** `liveDelivery` was true when the run ended, but a worktree can be
   deleted by hand — `git worktree list` must show the branch before you merge.

## The merge, then the cleanup

```
git merge --no-ff finisher/swarm/<runId>
git worktree remove --force <worktreeDir>
git branch -d finisher/swarm/<runId>
rm -f ~/.pi/finisher/<project>/delivery.json
```

- `--no-ff` (or a fast-forward) lands the exact tree that was checked, so the checks do not run again.
- A conflicted merge, `--squash` or any edit of your own makes a **new** tree: re-run
  `npm run typecheck && npm test` in the workspace before you call it done.
- `git branch -d` refusing means the branch still holds commits the merge did not take: keep the
  branch, name it in your report, and never reach for `-D` on unmerged work.
- If the human wants a review instead of a local merge: `git push origin finisher/swarm/<runId>` and
  open a PR. The worktree stays until that PR lands; the gates above still hold afterwards.

## What you say afterwards

- the merge commit, the branch, and that the worktree and branch are gone
- a merge you did **not** do, and the gate that stopped it (dirty tree, moved base, red checks) — that
  is the gate working, not the run failing
