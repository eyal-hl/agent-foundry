# Agent Foundry Slack bridge

A small always-on Socket Mode bridge that makes Slack a control surface for Agent Foundry while keeping GitHub as the durable source of truth.

## What it does

- `/foundry` shows configured open proposal issues and autonomous PRs.
- Proposal buttons dispatch the existing trusted `/challenge` and `/build` GitHub comments.
- PR buttons expose `/fix` only when the latest Reviewer or QA signal contains actionable AI findings.
- Only explicitly configured Slack user IDs may dispatch commands.
- `/build` is blocked by default until the Disagreer has returned `DISAGREER PASS` or `[AI-DISAGREE]` feedback.
- Duplicate clicks within two minutes are ignored.
- `#builds` receives dispatch activity and polls GitHub for autonomous PR, Reviewer, and QA state changes.
- There is intentionally no Merge button. Final merge remains a human GitHub gate.

## Secrets

Copy `.env.example` to `.env`. Never commit `.env`.

Required:

- `SLACK_BOT_TOKEN` — `xoxb-...` token from the installed Agent Foundry Slack app.
- `SLACK_APP_TOKEN` — `xapp-...` app-level token with `connections:write`.
- `GITHUB_TOKEN` — fine-grained PAT belonging to the trusted GitHub owner.
- `FOUNDRY_REPOS` — comma-separated `owner/repo` names.
- `FOUNDRY_ALLOWED_SLACK_USER_IDS` — comma-separated Slack user IDs allowed to dispatch actions.

Recommended GitHub fine-grained PAT repository permissions:

- Metadata: Read-only (automatic/basic access)
- Issues: Read and write
- Pull requests: Read-only

Select only repositories managed by this bridge. Using the human owner's PAT is intentional: the resulting exact GitHub comments are authored by the same trusted owner that Cursor's trigger restrictions already allow.

## Slack channel membership

Invite the `Agent Foundry` Slack app to `#foundry` and `#builds`. The manifest intentionally does not request `chat:write.public`, so the bot should only post to channels it has joined.

## Run with Docker

From this directory:

```bash
cp .env.example .env
# edit .env and insert the three secret tokens

docker compose up -d --build
docker compose logs -f
```

On first successful startup the logs should include the authenticated GitHub username and `Agent Foundry Slack bridge is running`.

Then run `/foundry` in Slack.

## Run without Docker

Requires Node.js 22+:

```bash
npm install
cp .env.example .env
# edit .env
npm run start:local
```

## Adding another project

1. Ensure the repository uses the Agent Foundry workflow and exact command triggers.
2. Add it to the Cursor role automations.
3. Add it to the fine-grained PAT's repository access.
4. Add `owner/repo` to `FOUNDRY_REPOS` and restart the bridge.

No Slack app changes are required.
