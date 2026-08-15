import { App } from "@slack/bolt";

const requiredEnv = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "GITHUB_TOKEN",
  "FOUNDRY_REPOS",
  "FOUNDRY_ALLOWED_SLACK_USER_IDS",
];

for (const name of requiredEnv) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const config = {
  githubToken: process.env.GITHUB_TOKEN.trim(),
  repos: process.env.FOUNDRY_REPOS.split(",").map((value) => value.trim()).filter(Boolean),
  allowedSlackUsers: new Set(
    process.env.FOUNDRY_ALLOWED_SLACK_USER_IDS.split(",").map((value) => value.trim()).filter(Boolean),
  ),
  buildsChannelId: process.env.FOUNDRY_BUILDS_CHANNEL_ID?.trim() || null,
  pollMs: Math.max(30, Number(process.env.FOUNDRY_POLL_SECONDS || "60")) * 1000,
  requireChallenge: (process.env.FOUNDRY_REQUIRE_CHALLENGE || "true").toLowerCase() !== "false",
};

if (config.repos.length === 0) {
  throw new Error("FOUNDRY_REPOS must contain at least one owner/repo value");
}

for (const repo of config.repos) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository in FOUNDRY_REPOS: ${repo}`);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const GITHUB_API = "https://api.github.com";
let githubLogin = null;

function repoParts(fullName) {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-foundry-slack-bridge",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 800);
    throw new Error(`GitHub ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getGithubLogin() {
  if (githubLogin) return githubLogin;
  const user = await githubRequest("/user");
  githubLogin = user.login;
  return githubLogin;
}

async function listOpenIssues(fullName) {
  const { owner, repo } = repoParts(fullName);
  const items = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&sort=updated&direction=desc&per_page=30`,
  );
  return items.filter((item) => !item.pull_request);
}

async function listOpenAutonomousPrs(fullName) {
  const { owner, repo } = repoParts(fullName);
  const prs = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
  );
  return prs.filter(
    (pr) => pr.head?.ref?.startsWith("agent/") || pr.labels?.some((label) => label.name === "ai:autonomous"),
  );
}

async function getIssue(fullName, number) {
  const { owner, repo } = repoParts(fullName);
  return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
}

async function getComments(fullName, number) {
  const { owner, repo } = repoParts(fullName);
  return githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=100`,
  );
}

async function postComment(fullName, number, body) {
  const { owner, repo } = repoParts(fullName);
  return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function newestSignal(comments, matchers) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i].body || "";
    for (const [status, matcher] of matchers) {
      if (matcher.test(body)) return { status, body };
    }
  }
  return { status: "pending", body: "" };
}

function issueState(comments) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = (comments[i].body || "").trim();
    if (body === "/build") return { status: "build", label: "🚀 Developer dispatched" };
    if (body === "DISAGREER PASS") {
      return { status: "challenge-ready", label: "✅ Challenge passed — ready for /build" };
    }
    if (body.startsWith("[AI-DISAGREE]")) {
      return { status: "challenge-ready", label: "🟡 Challenge feedback — reconcile, then /build" };
    }
    if (body === "/challenge") return { status: "challenge-pending", label: "⏳ Challenge running" };
  }
  return { status: "unchallenged", label: "⚪ Proposal — challenge not run" };
}

function prState(comments) {
  const review = newestSignal(comments, [
    ["pass", /^\s*AI REVIEW PASS\s*$/m],
    ["findings", /^\s*\[(?:AI-REVIEW|AI-SECURITY)\]/m],
  ]);
  const qa = newestSignal(comments, [
    ["pass", /^\s*QA PASS\b/m],
    ["findings", /^\s*\[AI-QA\]/m],
    ["blocked", /^\s*QA BLOCKED:/m],
  ]);

  const humanValidation = /AWAITING HUMAN VALIDATION/i.test(qa.body);
  return { review: review.status, qa: qa.status, humanValidation };
}

function reviewerLabel(status) {
  return {
    pass: "✅ pass",
    findings: "🔴 findings",
    pending: "⏳ pending",
  }[status] || status;
}

function qaLabel(status, humanValidation) {
  let label = {
    pass: "✅ pass",
    findings: "🔴 findings",
    blocked: "🟡 blocked",
    pending: "⏳ pending",
  }[status] || status;
  if (humanValidation) label += " · 🧑 device validation";
  return label;
}

function actionValue(repo, number) {
  return JSON.stringify({ repo, number });
}

function isConfiguredRepo(repo) {
  return config.repos.includes(repo);
}

function isAuthorizedSlackUser(userId) {
  return config.allowedSlackUsers.has(userId);
}

async function buildDashboard(selectedRepos = config.repos) {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Agent Foundry", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "GitHub is the source of truth. Buttons dispatch the existing trusted `/challenge`, `/build`, and `/fix` commands.",
        },
      ],
    },
  ];

  for (const repo of selectedRepos) {
    const [issues, prs] = await Promise.all([listOpenIssues(repo), listOpenAutonomousPrs(repo)]);
    const visibleIssues = issues.slice(0, 3);
    const visiblePrs = prs.slice(0, 3);

    const [issueComments, prComments] = await Promise.all([
      Promise.all(visibleIssues.map((issue) => getComments(repo, issue.number))),
      Promise.all(visiblePrs.map((pr) => getComments(repo, pr.number))),
    ]);

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${repo}*` },
    });

    if (visibleIssues.length === 0 && visiblePrs.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No open proposals or autonomous PRs._" },
      });
      continue;
    }

    for (let index = 0; index < visibleIssues.length; index += 1) {
      const issue = visibleIssues[index];
      const state = issueState(issueComments[index]);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Issue #${issue.number}* — <${issue.html_url}|${issue.title}>\n${state.label}`,
        },
      });

      const buttons = [
        {
          type: "button",
          text: { type: "plain_text", text: "Open issue", emoji: true },
          action_id: `foundry_open_issue_${repo.replace(/[^A-Za-z0-9]/g, "_")}_${issue.number}`,
          url: issue.html_url,
        },
      ];

      if (state.status === "unchallenged") {
        buttons.push({
          type: "button",
          text: { type: "plain_text", text: "Challenge", emoji: true },
          action_id: "foundry_challenge",
          value: actionValue(repo, issue.number),
        });
      } else if (state.status === "challenge-ready") {
        buttons.push({
          type: "button",
          text: { type: "plain_text", text: "Build", emoji: true },
          style: "primary",
          action_id: "foundry_build",
          value: actionValue(repo, issue.number),
        });
      }

      blocks.push({ type: "actions", elements: buttons });
    }

    for (let index = 0; index < visiblePrs.length; index += 1) {
      const pr = visiblePrs[index];
      const state = prState(prComments[index]);
      const needsFix = state.review === "findings" || state.qa === "findings";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*PR #${pr.number}* — <${pr.html_url}|${pr.title}>\n` +
            `Reviewer: ${reviewerLabel(state.review)} · QA: ${qaLabel(state.qa, state.humanValidation)}`,
        },
      });

      const buttons = [
        {
          type: "button",
          text: { type: "plain_text", text: "Open PR", emoji: true },
          action_id: `foundry_open_pr_${repo.replace(/[^A-Za-z0-9]/g, "_")}_${pr.number}`,
          url: pr.html_url,
        },
      ];

      if (needsFix) {
        buttons.push({
          type: "button",
          text: { type: "plain_text", text: "Fix findings", emoji: true },
          action_id: "foundry_fix",
          value: actionValue(repo, pr.number),
        });
      }

      blocks.push({ type: "actions", elements: buttons });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Use `/foundry <owner/repo>` to focus on one project." }],
  });
  return blocks.slice(0, 50);
}

async function wasRecentlyDispatched(repo, number, command) {
  const login = await getGithubLogin();
  const comments = await getComments(repo, number);
  const threshold = Date.now() - 2 * 60 * 1000;
  return comments.some(
    (comment) =>
      comment.user?.login === login &&
      (comment.body || "").trim() === command &&
      Date.parse(comment.created_at) >= threshold,
  );
}

async function validateDispatch(repo, number, command) {
  if (!isConfiguredRepo(repo)) throw new Error(`Repository is not configured: ${repo}`);
  if (!Number.isInteger(number) || number <= 0) throw new Error("Invalid issue/PR number");

  const item = await getIssue(repo, number);
  if (item.state !== "open") throw new Error(`GitHub item #${number} is no longer open`);
  const isPr = Boolean(item.pull_request);

  if ((command === "/challenge" || command === "/build") && isPr) {
    throw new Error(`${command} can only be dispatched on a GitHub issue`);
  }
  if (command === "/fix" && !isPr) {
    throw new Error("/fix can only be dispatched on a pull request");
  }

  const comments = await getComments(repo, number);
  if (command === "/challenge") {
    if (comments.some((comment) => (comment.body || "").trim() === "/build")) {
      throw new Error("Implementation has already been dispatched; challenge is closed for this issue");
    }
  }

  if (command === "/build" && config.requireChallenge) {
    const state = issueState(comments);
    if (state.status !== "challenge-ready") {
      throw new Error("/build is blocked until the Disagreer has returned PASS or feedback");
    }
  }

  if (command === "/fix") {
    const state = prState(comments);
    if (state.review !== "findings" && state.qa !== "findings") {
      throw new Error("/fix is blocked because there are no current AI review/QA findings");
    }
  }
}

async function postBuildFeed(client, text) {
  if (!config.buildsChannelId) return;
  try {
    await client.chat.postMessage({ channel: config.buildsChannelId, text });
  } catch (error) {
    app.logger.error("Could not post to builds channel", error);
  }
}

app.command("/foundry", async ({ ack, command, respond }) => {
  await ack();

  if (!isAuthorizedSlackUser(command.user_id)) {
    await respond({ response_type: "ephemeral", text: "You are not authorized to dispatch Agent Foundry actions." });
    return;
  }

  const input = command.text.trim();
  if (input.toLowerCase() === "help") {
    await respond({
      response_type: "ephemeral",
      text: "`/foundry` shows all configured projects. `/foundry owner/repo` focuses on one project.",
    });
    return;
  }

  let selectedRepos = config.repos;
  if (input) {
    const requested = input.includes("/") ? input : config.repos.find((repo) => repo.endsWith(`/${input}`));
    if (!requested || !isConfiguredRepo(requested)) {
      await respond({
        response_type: "ephemeral",
        text: `Unknown project. Configured repositories: ${config.repos.join(", ")}`,
      });
      return;
    }
    selectedRepos = [requested];
  }

  try {
    const blocks = await buildDashboard(selectedRepos);
    await respond({ response_type: "ephemeral", text: "Agent Foundry", blocks });
  } catch (error) {
    app.logger.error(error);
    await respond({ response_type: "ephemeral", text: `Could not load Agent Foundry: ${error.message}` });
  }
});

const dispatchActions = new Map([
  ["foundry_challenge", "/challenge"],
  ["foundry_build", "/build"],
  ["foundry_fix", "/fix"],
]);

app.action(/^foundry_open_/, async ({ ack }) => {
  await ack();
});

for (const [actionId, command] of dispatchActions) {
  app.action(actionId, async ({ ack, body, action, respond, client }) => {
    await ack();

    if (!isAuthorizedSlackUser(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You are not authorized to dispatch Agent Foundry actions." });
      return;
    }

    try {
      const payload = JSON.parse(action.value);
      const repo = payload.repo;
      const number = Number(payload.number);
      await validateDispatch(repo, number, command);

      if (await wasRecentlyDispatched(repo, number, command)) {
        await respond({
          response_type: "ephemeral",
          replace_original: false,
          text: `${command} was already dispatched on ${repo}#${number} in the last two minutes.`,
        });
        return;
      }

      const comment = await postComment(repo, number, command);
      const kind = command === "/fix" ? "PR" : "issue";
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `✅ Dispatched \`${command}\` on ${repo} ${kind} #${number}.`,
      });
      await postBuildFeed(
        client,
        `▶️ <@${body.user.id}> dispatched \`${command}\` on <${comment.html_url}|${repo}#${number}>.`,
      );
    } catch (error) {
      app.logger.error(error);
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `❌ Dispatch failed: ${error.message}`,
      });
    }
  });
}

const previousPrSnapshots = new Map();
let pollInitialized = false;

async function collectPrSnapshots() {
  const snapshots = new Map();
  for (const repo of config.repos) {
    const prs = await listOpenAutonomousPrs(repo);
    const comments = await Promise.all(prs.map((pr) => getComments(repo, pr.number)));
    for (let index = 0; index < prs.length; index += 1) {
      const pr = prs[index];
      const state = prState(comments[index]);
      snapshots.set(`${repo}#${pr.number}`, {
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        sha: pr.head.sha,
        draft: Boolean(pr.draft),
        review: state.review,
        qa: state.qa,
        humanValidation: state.humanValidation,
      });
    }
  }
  return snapshots;
}

function prStatusText(snapshot) {
  return `Reviewer ${reviewerLabel(snapshot.review)} · QA ${qaLabel(snapshot.qa, snapshot.humanValidation)}`;
}

async function pollGithub() {
  if (!config.buildsChannelId) return;
  try {
    const current = await collectPrSnapshots();

    if (!pollInitialized) {
      previousPrSnapshots.clear();
      for (const [key, value] of current) previousPrSnapshots.set(key, value);
      pollInitialized = true;
      return;
    }

    for (const [key, snapshot] of current) {
      const previous = previousPrSnapshots.get(key);
      if (!previous) {
        await postBuildFeed(
          app.client,
          `🆕 Autonomous PR opened: <${snapshot.url}|${snapshot.repo}#${snapshot.number} — ${snapshot.title}>\n${prStatusText(snapshot)}`,
        );
        continue;
      }

      const changes = [];
      if (previous.sha !== snapshot.sha) changes.push("new push");
      if (previous.review !== snapshot.review) changes.push(`Reviewer → ${reviewerLabel(snapshot.review)}`);
      if (previous.qa !== snapshot.qa || previous.humanValidation !== snapshot.humanValidation) {
        changes.push(`QA → ${qaLabel(snapshot.qa, snapshot.humanValidation)}`);
      }
      if (previous.draft !== snapshot.draft) changes.push(snapshot.draft ? "moved to draft" : "ready for review");

      if (changes.length > 0) {
        await postBuildFeed(
          app.client,
          `🔄 <${snapshot.url}|${snapshot.repo}#${snapshot.number}> — ${changes.join(" · ")}\n${prStatusText(snapshot)}`,
        );
      }
    }

    previousPrSnapshots.clear();
    for (const [key, value] of current) previousPrSnapshots.set(key, value);
  } catch (error) {
    app.logger.error("GitHub polling failed", error);
  }
}

(async () => {
  const login = await getGithubLogin();
  app.logger.info(`GitHub authenticated as ${login}`);
  await app.start();
  app.logger.info(`⚡ Agent Foundry Slack bridge is running for ${config.repos.join(", ")}`);
  await pollGithub();
  setInterval(pollGithub, config.pollMs).unref();
})();
