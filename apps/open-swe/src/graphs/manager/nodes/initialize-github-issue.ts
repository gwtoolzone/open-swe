import { v4 as uuidv4 } from "uuid";
import { GraphConfig } from "@open-swe/shared/open-swe/types";
import {
  ManagerGraphState,
  ManagerGraphUpdate,
} from "@open-swe/shared/open-swe/manager/types";
import { getGitHubTokensFromConfig } from "../../../utils/github-tokens.js";
import { HumanMessage, isHumanMessage } from "@langchain/core/messages";
import { getIssue } from "../../../utils/github/api.js";
import { extractTasksFromIssueContent } from "../../../utils/github/issue-task.js";
import { getMessageContentFromIssue } from "../../../utils/github/issue-messages.js";
import { isLocalMode } from "@open-swe/shared/open-swe/local-mode";
import { createLogger, LogLevel } from "../../../utils/logger.js";

const logger = createLogger(LogLevel.INFO, "InitializeGithubIssue");

/**
 * The initialize function will do nothing if there's already a human message
 * in the state. If not, it will attempt to get the human message from the GitHub issue.
 */
export async function initializeGithubIssue(
  state: ManagerGraphState,
  config: GraphConfig,
): Promise<ManagerGraphUpdate> {
  logger.info("Initializing GitHub issue", {
    githubIssueId: state.githubIssueId,
    targetRepository: state.targetRepository,
    messagesCount: state.messages.length,
    hasTaskPlan: !!state.taskPlan,
    isLocalMode: isLocalMode(config)
  });
  
  if (isLocalMode(config)) {
    logger.info("Running in local mode, skipping GitHub issue initialization");
    // In local mode, we don't need GitHub issues
    // The human message should already be in the state from the CLI input
    return {};
  }
  
  const { githubInstallationToken } = getGitHubTokensFromConfig(config);
  let taskPlan = state.taskPlan;
  
  const humanMessagesCount = state.messages.filter(isHumanMessage).length;
  logger.info("Checking existing messages", {
    totalMessages: state.messages.length,
    humanMessages: humanMessagesCount
  });

  if (state.messages.length && state.messages.some(isHumanMessage)) {
    logger.info("Found existing human messages, checking for task plan updates");
    // If there are messages, & at least one is a human message, only attempt to read the updated plan from the issue.
    if (state.githubIssueId) {
      logger.info("Fetching GitHub issue for task plan update", {
        githubIssueId: state.githubIssueId
      });
      const issue = await getIssue({
        owner: state.targetRepository.owner,
        repo: state.targetRepository.repo,
        issueNumber: state.githubIssueId,
        githubInstallationToken,
      });
      if (!issue) {
        logger.error("GitHub issue not found", {
          githubIssueId: state.githubIssueId,
          owner: state.targetRepository.owner,
          repo: state.targetRepository.repo
        });
        throw new Error("Issue not found");
      }
      logger.info("GitHub issue fetched successfully for task plan update", {
        issueTitle: issue.title,
        issueBodyLength: issue.body?.length || 0,
        issueState: issue.state
      });
      
      if (issue.body) {
        const extractedTaskPlan = extractTasksFromIssueContent(issue.body);
        if (extractedTaskPlan) {
          logger.info("Task plan extracted from GitHub issue", {
            tasksCount: extractedTaskPlan.tasks.length,
            activeTaskIndex: extractedTaskPlan.activeTaskIndex
          });
          taskPlan = extractedTaskPlan;
        } else {
          logger.info("No task plan found in GitHub issue body");
        }
      }
    }

    logger.info("Returning task plan update", {
      hasTaskPlan: !!taskPlan,
      tasksCount: taskPlan?.tasks.length || 0
    });
    return {
      taskPlan,
    };
  }

  // If there are no messages, ensure there's a GitHub issue to fetch the message from.
  if (!state.githubIssueId) {
    logger.error("Missing GitHub issue ID for initialization", {
      hasGithubIssueId: !!state.githubIssueId
    });
    throw new Error("GitHub issue ID not provided");
  }
  if (!state.targetRepository) {
    logger.error("Missing target repository for initialization", {
      hasTargetRepository: !!state.targetRepository
    });
    throw new Error("Target repository not provided");
  }

  const issue = await getIssue({
    owner: state.targetRepository.owner,
    repo: state.targetRepository.repo,
    issueNumber: state.githubIssueId,
    githubInstallationToken,
  });
  if (!issue) {
    logger.error("GitHub issue not found during initialization", {
      githubIssueId: state.githubIssueId,
      owner: state.targetRepository.owner,
      repo: state.targetRepository.repo
    });
    throw new Error("Issue not found");
  }
  logger.info("GitHub issue fetched successfully for initialization", {
    issueTitle: issue.title,
    issueBodyLength: issue.body?.length || 0,
    issueState: issue.state
  });
  
  if (issue.body) {
    const extractedTaskPlan = extractTasksFromIssueContent(issue.body);
    if (extractedTaskPlan) {
        logger.info("Task plan extracted from GitHub issue during initialization", {
          tasksCount: extractedTaskPlan.tasks.length,
          activeTaskIndex: extractedTaskPlan.activeTaskIndex
        });
        taskPlan = extractedTaskPlan;
      } else {
        logger.info("No task plan found in GitHub issue body during initialization");
      }
  }

  logger.info("Creating human message from GitHub issue", {
    githubIssueId: state.githubIssueId
  });
  
  const newMessage = new HumanMessage({
    id: uuidv4(),
    content: getMessageContentFromIssue(issue),
    additional_kwargs: {
      githubIssueId: state.githubIssueId,
      isOriginalIssue: true,
    },
  });
  
  logger.info("GitHub issue initialization completed", {
    newMessagesCount: 1,
    hasTaskPlan: !!taskPlan,
    tasksCount: taskPlan?.tasks.length || 0
  });

  return {
    messages: [newMessage],
    taskPlan,
  };
}
