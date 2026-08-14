# Cursor Automations

Cursor owns triggers, models, and tool permissions. The repository owns agent behavior.

The files under `automation-prompts/` are the authoritative role instructions. Cursor automation prompts should stay deliberately small and reusable across many repositories: determine which repository triggered the run, load the matching role file from a trusted ref, then execute it.

This lets one Cursor automation serve many Agent Foundry repositories while each repository keeps its own architecture, product, test, platform, and safety caveats in source control.

## Recommended roles

| Automation | Suggested model | Trigger | Writes code? |
|---|---|---|---|
| Disagreer | strong independent reasoning model from a different family | issue comment exactly `/challenge` | No |
| Developer | Grok 4.6, high effort | issue comment exactly `/build` | Yes |
| Independent Reviewer | Claude Sonnet 5 | draft opened + PR opened + PR pushed | No |
| Product QA | Grok 4.6, medium/high | draft opened + PR opened + PR pushed | No |
| Fixer | Grok 4.6, high effort | top-level PR comment exactly `/fix` | Yes |

Model availability and pricing change. The architectural requirement is role separation and independent reasoning at important gates, not a particular vendor.

## Authoritative prompt loading

The automation must never trust role instructions from unreviewed code.

Use this rule on every run:

- **Issue-triggered roles** (`disagreer`, `developer`) load `automation-prompts/<role>.md` from the repository **default branch**.
- **PR-triggered roles** (`reviewer`, `qa`, `fixer`) load `automation-prompts/<role>.md` from the PR **base branch**.
- Never load the authoritative role prompt from the PR head/source branch.
- If the trusted role file does not exist, stop without taking action.

A PR may propose changing an automation prompt, but that new prompt becomes authoritative only after a human merges it.

This prevents an implementation branch from changing `reviewer.md` to approve itself, weakening QA, or expanding Fixer permissions.

## Shared Cursor automations

Prefer one Cursor automation per role with all participating repositories selected, rather than one full set per project.

The Cursor-side prompt should only bootstrap the repository-owned prompt. Project-specific instructions belong in the repository.

Example shape:

```text
Cursor Disagreer ─┐
Cursor Developer ─┤
Cursor Reviewer ──┤── selected repositories ──> automation-prompts/*.md
Cursor QA ─────────┤
Cursor Fixer ──────┘
```

When a new repository is created from Agent Foundry, customize its role files as needed and add the repository to the existing Cursor automations.

## Disagreement gate

Cursor does not currently expose an issue-created trigger, so the Disagreer uses an explicit trusted issue comment:

```text
/challenge
```

When ChatGPT creates a proposal, it may immediately dispatch `/challenge` on behalf of the trusted owner. This keeps the architecture challenge before `/build` without requiring a separate automation per repository.

Its purpose is constructive adversarial review of the **plan**, not implementation review. It should challenge material assumptions such as architecture, unnecessary complexity, missing constraints, unsafe coupling, hidden platform risks, poor acceptance criteria, and simpler alternatives.

It must not manufacture objections merely to disagree. `DISAGREER PASS` is a valid result.

Disagreer comments are advisory. A human/ChatGPT product pass reconciles useful findings into the issue before approval.

```text
proposal issue → /challenge → Disagreer → human/ChatGPT reconcile → /build
```

## Approval / dispatch

Use an exact trusted issue comment `/build` as the implementation approval command. `agent:build` is useful semantic state, but the explicit command is the dispatch.

The Developer must independently verify its trigger guard from the trusted repository instructions before writing code.

## Review and QA

Reviewer and QA run independently on autonomous PR creation and subsequent pushes.

Include both **draft opened** and **PR opened** because autonomous agents may create draft PRs. Include **PR pushed** so repairs are automatically re-reviewed.

- Reviewer is code/spec/architecture oriented.
- QA is behavior/product oriented and should exercise the runnable product when practical.
- Both ignore non-autonomous PRs according to the repository role prompt.
- Neither edits code or merges.

## Repair dispatch

Reviewer and QA report findings. Code repair requires an explicit trusted `/fix` top-level PR conversation comment.

Fixer only acts on workflow findings explicitly allowed by its repository prompt, normally `[AI-REVIEW]`, `[AI-QA]`, and `[AI-SECURITY]`.

Each `/fix` authorizes one repair pass and then stops. There is no fixed lifetime round limit: the trusted human may dispatch another `/fix` whenever another repair pass is warranted. The Fixer must never self-dispatch or recursively continue repairing without a new trusted human command.

If a finding cannot be safely repaired, the Fixer should report `needs-human` rather than guess.

## Trigger hygiene

- Restrict issue/PR creation to collaborators where appropriate for public automation-driven repositories.
- Prefer exact keyword filters for `/challenge`, `/build`, and `/fix` in Cursor as a first line of defense.
- Keep the same checks again inside the repository-owned role prompt.
- Reviewer/QA should scope themselves to autonomous PRs, normally an `agent/` head branch or `ai:autonomous` label.
- Never treat arbitrary issue or PR prose as trusted instructions to edit code.
- Never allow any automation to merge the default branch.
- Disable PR approval capability for Reviewer/QA when comments are sufficient; the human remains the release gate.

## Human gates

1. Human reviews/reconciles the proposal after Disagreer feedback.
2. Human approves implementation before `/build`.
3. Human dispatches each `/fix` repair pass when desired.
4. Human performs any environment/device validation agents cannot genuinely perform.
5. Human merges the final PR.
