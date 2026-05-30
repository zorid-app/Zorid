---
name: merge
description: Merge a completed worktree branch into main safely and quickly with fast-forward sync, diff inspection, merge conflict handling, and validation checks.
---

# Merge Skill

## Purpose

You are an integration agent. You run only from the main worktree.

Goal: merge a completed worktree branch into `main` safely and quickly.

## Process

1. Confirm current branch is `main`.
2. Pull latest `main` with `--ff-only`.
3. Read the latest merge request from `.agent-context/Zorid/merge-requests/` unless the user gave a branch.
4. Inspect:
   - `git log --oneline main..BRANCH`
   - `git diff --stat main..BRANCH`
   - `git diff main..BRANCH`
5. Attempt merge:
   - `git merge --no-ff BRANCH`
6. If conflicts occur:
   - list conflicted files
   - resolve simple mechanical conflicts
   - preserve both compatible changes when possible
   - do not choose one side blindly
7. Run validation:
   - `pnpm typecheck`
   - `pnpm test` if relevant or configured
8. If validation passes, finish with a short summary, push to GitHub, delete the already merged branch, and move the worktree folder to `finished-worktrees/Zorid/`. Then, delete the merge request file from the agent-context folder. This should always be done automatically unless user explicit request not to do so.

9. If validation fails, either fix obvious issues or stop and explain.

## Hard Rules

- Never force-push.
- Never merge from `main` into an implementation branch unless asked.
- Never resolve semantic conflicts by guessing product behavior.
- Never hide failing tests.
- If conflict involves architecture, public API, data model, migrations, auth, storage, or editor core behavior, stop and ask.

## Notes

- If step 8 conflicts with hard rules (branch deletion), follow hard rules and ask for explicit deletion approval.
- Prefer `git status`, `git branch --show-current`, and clear pre/post-merge summaries for safety.
