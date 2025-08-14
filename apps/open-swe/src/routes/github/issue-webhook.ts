import { v4 as uuidv4 } from "uuid";
import { Context } from "hono";
import { BlankEnv, BlankInput } from "hono/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { GitHubApp } from "../../utils/github-app.js";
import { Webhooks } from "@octokit/webhooks";
import { createLangGraphClient } from "../../utils/langgraph-client.js";
import {
  GITHUB_INSTALLATION_ID,
  GITHUB_INSTALLATION_NAME,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_USER_ID_HEADER,
  GITHUB_USER_LOGIN_HEADER,
  MANAGER_GRAPH_ID,
  OPEN_SWE_STREAM_MODE,
} from "@open-swe/shared/constants";
import { encryptSecret } from "@open-swe/shared/crypto";
import { HumanMessage } from "@langchain/core/messages";
import {
  getOpenSWEAutoAcceptLabel,
  getOpenSWELabel,
  getOpenSWEMaxLabel,
  getOpenSWEMaxAutoAcceptLabel,
} from "../../utils/github/label.js";
import { ManagerGraphUpdate } from "@open-swe/shared/open-swe/manager/types";
import { RequestSource } from "../../constants.js";
import { isAllowedUser } from "@open-swe/shared/github/allowed-users";
import { getOpenSweAppUrl } from "../../utils/url-helpers.js";
import { StreamMode } from "@langchain/langgraph-sdk";

const logger = createLogger(LogLevel.INFO, "GitHubIssueWebhook");

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

const githubApp = new GitHubApp();

const webhooks = new Webhooks({
  secret: GITHUB_WEBHOOK_SECRET,
});

const getPayload = (body: string): Record<string, any> | null => {
  try {
    logger.info("Parsing webhook payload", { bodyLength: body.length });
    const payload = JSON.parse(body);
    logger.info("Successfully parsed webhook payload", {
      action: payload.action,
      issueNumber: payload.issue?.number,
      labelName: payload.label?.name,
      repository: payload.repository?.full_name,
      sender: payload.sender?.login
    });
    return payload;
  } catch (error) {
    logger.error("Failed to parse webhook payload", { error: (error as Error).message, bodyLength: body.length });
    return null;
  }
};

const createDevMetadataComment = (runId: string, threadId: string) => {
  return `<details>
  <summary>Dev Metadata</summary>
  ${JSON.stringify(
    {
      runId,
      threadId,
    },
    null,
    2,
  )}
</details>`;
};

const getHeaders = (
  c: Context,
): {
  id: string;
  name: string;
  installationId: string;
  targetType: string;
} | null => {
  const headers = c.req.header();
  const webhookId = headers["x-github-delivery"] || "";
  const webhookEvent = headers["x-github-event"] || "";
  const installationId = headers["x-github-hook-installation-target-id"] || "";
  const targetType = headers["x-github-hook-installation-target-type"] || "";
  
  logger.info("Extracting webhook headers", {
    webhookId: webhookId || "missing",
    webhookEvent: webhookEvent || "missing",
    installationId: installationId || "missing",
    targetType: targetType || "missing"
  });
  
  if (!webhookId || !webhookEvent || !installationId || !targetType) {
    logger.error("Missing required webhook headers", {
      missingHeaders: {
        webhookId: !webhookId,
        webhookEvent: !webhookEvent,
        installationId: !installationId,
        targetType: !targetType
      }
    });
    return null;
  }
  
  logger.info("Successfully extracted all required webhook headers");
  return { id: webhookId, name: webhookEvent, installationId, targetType };
};

webhooks.on("issues.labeled", async ({ payload }) => {
  logger.info("Processing issues.labeled webhook event", {
    issueNumber: payload.issue?.number,
    labelName: payload.label?.name,
    repository: payload.repository?.full_name,
    sender: payload.sender?.login
  });
  
  if (!process.env.SECRETS_ENCRYPTION_KEY) {
    logger.error("SECRETS_ENCRYPTION_KEY environment variable is required");
    throw new Error("SECRETS_ENCRYPTION_KEY environment variable is required");
  }
  
  const validOpenSWELabels = [
    getOpenSWELabel(),
    getOpenSWEAutoAcceptLabel(),
    getOpenSWEMaxLabel(),
    getOpenSWEMaxAutoAcceptLabel(),
  ];
  
  logger.info("Checking if label is valid Open SWE label", {
    labelName: payload.label?.name,
    validLabels: validOpenSWELabels,
    isValidLabel: validOpenSWELabels.some((l) => l === payload.label?.name)
  });
  
  if (
    !payload.label?.name ||
    !validOpenSWELabels.some((l) => l === payload.label?.name)
  ) {
    logger.info("Ignoring event - not a valid Open SWE label", {
      labelName: payload.label?.name
    });
    return;
  }
  const isAutoAcceptLabel =
    payload.label.name === getOpenSWEAutoAcceptLabel() ||
    payload.label.name === getOpenSWEMaxAutoAcceptLabel();

  const isMaxLabel =
    payload.label.name === getOpenSWEMaxLabel() ||
    payload.label.name === getOpenSWEMaxAutoAcceptLabel();

  logger.info(
    `'${payload.label.name}' label added to issue #${payload.issue.number}`,
    {
      isAutoAcceptLabel,
      isMaxLabel,
    },
  );

  try {
    logger.info("Starting webhook processing for valid Open SWE label");
    
    // Get installation ID from the webhook payload
    const installationId = payload.installation?.id;

    if (!installationId) {
      logger.error("No installation ID found in webhook payload", {
        payloadKeys: Object.keys(payload)
      });
      return;
    }
    
    logger.info("Found installation ID, getting GitHub authentication", {
      installationId
    });

    const [octokit, { token }] = await Promise.all([
      githubApp.getInstallationOctokit(installationId),
      githubApp.getInstallationAccessToken(installationId),
    ]);
    
    logger.info("Successfully obtained GitHub authentication");
    const issueData = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
      issueTitle: payload.issue.title,
      issueBody: payload.issue.body || "",
      userId: payload.sender.id,
      userLogin: payload.sender.login,
    };

    logger.info("Checking user permissions", {
      userLogin: issueData.userLogin,
      userId: issueData.userId
    });
    
    if (!isAllowedUser(issueData.userLogin)) {
      logger.error("User is not a member of allowed orgs", {
        username: issueData.userLogin,
      });
      return;
    }
    
    logger.info("User permission check passed");

    logger.info("Creating LangGraph client with authentication headers");
    
    const langGraphClient = createLangGraphClient({
      defaultHeaders: {
        [GITHUB_INSTALLATION_TOKEN_COOKIE]: encryptSecret(
          token,
          process.env.SECRETS_ENCRYPTION_KEY,
        ),
        [GITHUB_INSTALLATION_NAME]: issueData.owner,
        [GITHUB_USER_ID_HEADER]: issueData.userId.toString(),
        [GITHUB_USER_LOGIN_HEADER]: issueData.userLogin,
        [GITHUB_INSTALLATION_ID]: installationId.toString(),
      },
    });
    
    logger.info("LangGraph client created successfully");

    const threadId = uuidv4();
    
    logger.info("Preparing run input and configuration", {
      threadId,
      issueNumber: issueData.issueNumber,
      autoAcceptPlan: isAutoAcceptLabel,
      isMaxLabel,
      issueTitle: issueData.issueTitle,
      issueBodyLength: issueData.issueBody.length
    });
    
    const runInput: ManagerGraphUpdate = {
      messages: [
        new HumanMessage({
          id: uuidv4(),
          content: `**${issueData.issueTitle}**\n\n${issueData.issueBody}`,
          additional_kwargs: {
            isOriginalIssue: true,
            githubIssueId: issueData.issueNumber,
            requestSource: RequestSource.GITHUB_ISSUE_WEBHOOK,
          },
        }),
      ],
      githubIssueId: issueData.issueNumber,
      targetRepository: {
        owner: issueData.owner,
        repo: issueData.repo,
      },
      autoAcceptPlan: isAutoAcceptLabel,
    };
    
    // Create config object with Claude Opus 4.1 model configuration for max labels
    const config: Record<string, any> = {
      recursion_limit: 400,
    };

    if (isMaxLabel) {
      logger.info("Using Claude Opus 4.1 model for max label");
      config.configurable = {
        plannerModelName: "anthropic:claude-opus-4-1",
        programmerModelName: "anthropic:claude-opus-4-1",
      };
    }

    logger.info("Creating LangGraph run", {
      threadId,
      graphId: MANAGER_GRAPH_ID,
      configRecursionLimit: config.recursion_limit,
      hasConfigurable: !!config.configurable
    });
    
    const run = await langGraphClient.runs.create(threadId, MANAGER_GRAPH_ID, {
      input: runInput,
      config,
      ifNotExists: "create",
      streamResumable: true,
      streamMode: OPEN_SWE_STREAM_MODE as StreamMode[],
    });
    
    logger.info("LangGraph run created successfully", {
      runId: run.run_id,
      threadId
    });

    logger.info("Created new run from GitHub issue.", {
      threadId,
      runId: run.run_id,
      issueNumber: issueData.issueNumber,
      owner: issueData.owner,
      repo: issueData.repo,
      userId: issueData.userId,
      userLogin: issueData.userLogin,
      autoAcceptPlan: isAutoAcceptLabel,
    });

    logger.info("Creating GitHub issue comment", {
      owner: issueData.owner,
      repo: issueData.repo,
      issueNumber: issueData.issueNumber
    });
    
    const appUrl = getOpenSweAppUrl(threadId);
    const appUrlCommentText = appUrl
      ? `View run in Open SWE [here](${appUrl}) (this URL will only work for @${issueData.userLogin})`
      : "";
      
    logger.info("Generated app URL for comment", {
      hasAppUrl: !!appUrl,
      appUrl: appUrl || "not generated"
    });
    
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: issueData.owner,
        repo: issueData.repo,
        issue_number: issueData.issueNumber,
        body: `🤖 Open SWE has been triggered for this issue. Processing...\n\n${appUrlCommentText}\n\n${createDevMetadataComment(run.run_id, threadId)}`,
      },
    );
    
    logger.info("GitHub issue comment created successfully");
  } catch (error) {
    logger.error("Error processing webhook event", {
      error: (error as Error).message,
      stack: (error as Error).stack,
      issueNumber: payload.issue?.number,
      repository: payload.repository?.full_name,
      labelName: payload.label?.name,
      sender: payload.sender?.login,
      installationId: payload.installation?.id
    });
    
    // Try to add an error comment to the issue if possible
    try {
      if (payload.installation?.id && payload.repository && payload.issue) {
        logger.info("Attempting to add error comment to GitHub issue");
        const [octokit] = await Promise.all([
          githubApp.getInstallationOctokit(payload.installation.id),
        ]);
        
        await octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            issue_number: payload.issue.number,
            body: `❌ Open SWE encountered an error while processing this issue. Please check the logs or try again later.\n\nError: ${(error as Error).message}`,
          },
        );
        
        logger.info("Error comment added to GitHub issue successfully");
      }
    } catch (commentError) {
      logger.error("Failed to add error comment to GitHub issue", {
        commentError: (commentError as Error).message
      });
    }
  }
});

export async function issueWebhookHandler(
  c: Context<BlankEnv, "/webhooks/github", BlankInput>,
) {
  logger.info("Received GitHub webhook request", {
    method: c.req.method,
    url: c.req.url,
    userAgent: c.req.header("user-agent"),
    contentType: c.req.header("content-type")
  });
  
  const requestBody = await c.req.text();
  const payload = getPayload(requestBody);
  if (!payload) {
    logger.error("Missing or invalid payload");
    return c.json({ error: "Missing payload" }, { status: 400 });
  }

  const eventHeaders = getHeaders(c);
  if (!eventHeaders) {
    logger.error("Missing webhook headers");
    return c.json({ error: "Missing webhook headers" }, { status: 400 });
  }

  try {
    logger.info("Processing webhook with GitHub webhooks library", {
      eventId: eventHeaders.id,
      eventName: eventHeaders.name,
      installationId: eventHeaders.installationId,
      targetType: eventHeaders.targetType
    });
    
    await webhooks.receive({
      id: eventHeaders.id,
      name: eventHeaders.name as any,
      payload,
    });

    logger.info("Webhook processed successfully", {
      eventId: eventHeaders.id,
      eventName: eventHeaders.name
    });
    
    return c.json({ received: true });
  } catch (error) {
    logger.error("Webhook processing failed", {
      error: (error as Error).message,
      eventId: eventHeaders.id,
      eventName: eventHeaders.name,
      stack: (error as Error).stack
    });
    return c.json({ error: "Webhook processing failed" }, { status: 400 });
  }
}
