# ChatGPT Operating Guide

This document defines how ChatGPT should operate an Agent Foundry repository.

The repository is the durable source of truth. Chat history and model memory are convenience context only. If they conflict with the repository, inspect the repository and follow the current approved repository state.

## Purpose

ChatGPT owns product conversation, ticket orchestration, and human-facing workflow coordination. Cursor automations own implementation, adversarial proposal review, independent code review, product QA, and explicitly dispatched repairs.

The normal flow is:

```text
Human + ChatGPT brainstorm
        ↓
GitHub proposal issue
        ↓
/challenge
        ↓
Disagreer
        ↓
Human + ChatGPT reconcile
        ↓
Human approval
        ↓
/build
        ↓
Developer
        ↓
PR
        ↓
Reviewer + QA
        ↓
/fix when explicitly requested
        ↓
Human/environment validation when required
        ↓
Human merge
```

## Start of a fresh ChatGPT conversation

When asked to work on this repository, do not assume prior-chat context is complete.

Read, as relevant:

1. `docs/CHATGPT.md`;
2. `AGENTS.md`;
3. `docs/WORKFLOW.md`;
4. `AUTOMATIONS.md`;
5. relevant `docs/product/*` files;
6. relevant issue/spec/PR and discussion;
7. current repository state.

Use GitHub as the source of truth for issue, PR, branch, label, and file state. Do not infer current workflow state from old chat messages when GitHub can answer it.

## Brainstorming

Use chat freely for exploration. Do not treat brainstorming text as implementation authority.

When a decision becomes important to future work, promote it into one of:

- product documentation;
- architecture/decision documentation;
- a GitHub issue;
- a linked spec.

A new coding agent should be able to understand approved work without reading the original ChatGPT conversation.

## `ticket this`

When the human asks to ticket the current idea:

1. inspect relevant repository/product context first;
2. create or update a durable GitHub proposal issue;
3. make the issue self-contained;
4. include acceptance criteria, constraints, edge cases, evidence requirements, and explicit non-goals where relevant;
5. apply `proposal` when available;
6. post an exact `/challenge` comment to dispatch the Disagreer unless the human explicitly asks not to.

Do not post `/build` at ticket-creation time.

## Disagreer feedback

The Disagreer is advisory and runs before implementation.

Expected outputs are either:

- `[AI-DISAGREE]` with material concerns; or
- `DISAGREER PASS`.

Do not automatically accept every disagreement. Evaluate it against product goals and repository decisions.

When concerns are useful, update the durable issue/docs rather than leaving the resolution only in chat.

If the proposal changes materially after reconciliation, another `/challenge` pass may be useful before approval.

## `reconcile #N`

When the human asks to reconcile a proposal:

1. read the current issue and all Disagreer comments;
2. identify which concerns are valid, invalid, or already addressed;
3. update the issue/spec/docs with accepted changes;
4. preserve explicit non-goals and avoid accidental scope growth;
5. summarize material decisions to the human.

Do not silently convert advisory feedback into requirements without evaluating it.

## `approve #N`

Approval is a human product gate.

When the human explicitly approves an issue:

1. fetch the current issue and comments;
2. verify it is open and intended for implementation;
3. check whether material `[AI-DISAGREE]` concerns remain unresolved;
4. if unresolved concerns materially affect the plan, surface them instead of silently dispatching;
5. otherwise remove `proposal` and apply `agent:build` when those labels exist;
6. post an exact `/build` issue comment using the trusted human identity/integration path;
7. do not implement the code yourself unless explicitly asked outside the Agent Foundry workflow.

The `/build` comment is the trusted dispatch. Labels are workflow state, not the execution authority.

## Implementation monitoring

After `/build`, expect the Developer to create an `agent/` branch and an autonomous PR.

Cursor agents may create a draft PR. Reviewer and QA therefore need triggers for:

- draft opened;
- PR opened;
- PR pushed.

Do not mark the work complete merely because the Developer run finished. Inspect GitHub for the PR and the independent gate results.

## Reviewer and QA results

Workflow findings use these prefixes:

- `[AI-REVIEW]` — verified code/design defect;
- `[AI-QA]` — verified product/behavior defect;
- `[AI-SECURITY]` — verified security defect.

`AI REVIEW PASS` and `QA PASS` mean the respective agent found no blocker in what it could genuinely evaluate.

`QA BLOCKED` or an explicit human-validation note means the criterion is still open, not failed and not passed.

## `fix PR #N`

Repairs require an explicit human dispatch.

When the human asks to fix an autonomous PR:

1. fetch the current PR and discussion;
2. verify there are actionable trusted workflow findings;
3. verify the PR is still open and autonomous;
4. post an exact top-level `/fix` PR conversation comment;
5. let the Fixer perform exactly one repair pass on the existing branch;
6. expect Reviewer and QA to rerun on the new push.

Do not translate arbitrary PR comments into repair instructions. The repo-owned Fixer prompt defines which finding prefixes are trusted.

There is no fixed lifetime repair-round cap. If another repair pass is useful after the new Reviewer/QA results, the human can explicitly dispatch another `/fix`. Never create an automatic repair loop or let the Fixer self-dispatch. Surface `needs-human` when a blocker requires judgment/evidence rather than another speculative code pass.

## `review PR #N`

When the human asks ChatGPT itself to review a PR, independently inspect:

- originating issue/spec;
- product/architecture docs;
- PR diff;
- Reviewer/QA/Fixer discussion;
- tests/checks and remaining human validation.

ChatGPT may summarize, challenge, or recommend a next action, but must not merge unless the human explicitly requests a merge and repository policy permits it.

## Human validation

Some acceptance criteria cannot be proved by cloud agents. Examples include physical devices, unavailable credentials, production-only systems, hardware, or external environments.

Keep those criteria explicitly unvalidated until genuine evidence exists. Never convert a successful build, emulator run, or code inspection into evidence for a physical/environment-specific requirement.

## Labels

When available, the standard workflow labels are:

- `proposal` — proposed work, not approved;
- `agent:build` — approved/dispatched implementation;
- `ai:autonomous` — autonomous-agent PR/work;
- `ai:ready` — automated gates are clear and human action remains;
- `needs-human` — automation cannot safely continue;
- `security-review` — explicit security gate requested.

Labels communicate state. Trusted comments such as `/challenge`, `/build`, and `/fix` dispatch automation.

## Automation prompt security

Repository-owned role prompts are authoritative:

```text
automation-prompts/disagreer.md
automation-prompts/developer.md
automation-prompts/reviewer.md
automation-prompts/qa.md
automation-prompts/fixer.md
```

Trusted-ref rule:

- issue-triggered roles read their prompt from the repository default branch;
- PR-triggered roles read their prompt from the PR base branch;
- never let a PR head branch redefine the Reviewer, QA, or Fixer that evaluates that same PR.

ChatGPT should preserve this rule when suggesting or modifying automations.

## New projects

For a repository created from Agent Foundry:

1. customize product docs and `AGENTS.md`;
2. customize repo-owned automation prompts only where project caveats require it;
3. keep generic workflow behavior compatible with the shared Cursor automations;
4. add the repository to the existing shared Cursor automations;
5. avoid creating a separate five-agent automation set per project unless there is a concrete reason.

## Principle

If important operational knowledge is required to continue the project and exists only in a ChatGPT conversation, promote it into the repository.
