/**
 * Tool definitions and handler dispatch for gh-mcp
 */

import { Tool } from "@modelcontextprotocol/server";
import * as commits from "./commits.js";
import * as files from "./files.js";
import * as user from "./user.js";
import * as branches from "./branches.js";
import * as pullRequests from "./pullRequests.js";
import * as search from "./search.js";

// Tool definitions matching the GitHub MCP server schema
const TOOL_DEFS: Tool[] = [
  // Commit tools
  {
    name: "get_commit",
    description: "Get details for a commit from a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        sha: { type: "string", description: "Commit SHA, branch name, or tag name" },
        include_diff: { type: "boolean", description: "Include file diffs and stats (default: true)", default: true },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["owner", "repo", "sha"],
    },
  },
  {
    name: "list_commits",
    description: "Get list of commits of a branch in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        sha: { type: "string", description: "Branch or tag to list commits from" },
        author: { type: "string", description: "Filter by author username or email" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["owner", "repo"],
    },
  },

  // File tools
  {
    name: "get_file_contents",
    description: "Get the contents of a file or directory from a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "Path to file/directory", default: "/" },
        ref: { type: "string", description: "Git ref (branch, tag, or SHA)" },
        sha: { type: "string", description: "Commit SHA (overrides ref if provided)" },
      },
      required: ["owner", "repo"],
    },
  },

  // User tools
  {
    name: "get_me",
    description: "Get details of the authenticated GitHub user",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_teams",
    description: "Get details of the teams the user is a member of",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Username (defaults to authenticated user)" },
      },
      required: [],
    },
  },
  {
    name: "get_team_members",
    description: "Get member usernames of a specific team in an organization",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        team_slug: { type: "string", description: "Team slug" },
      },
      required: ["org", "team_slug"],
    },
  },

  // Branch tools
  {
    name: "list_branches",
    description: "List branches in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["owner", "repo"],
    },
  },

  // Pull request tools
  {
    name: "list_pull_requests",
    description: "List pull requests in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state" },
        head: { type: "string", description: "Filter by head user/org and branch" },
        base: { type: "string", description: "Filter by base branch" },
        sort: { type: "string", enum: ["created", "updated", "popularity", "long-running"], description: "Sort by" },
        direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "pull_request_read",
    description: "Get information on a specific pull request",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        pullNumber: { type: "number", description: "Pull request number" },
        method: {
          type: "string",
          enum: ["get", "get_diff", "get_status", "get_files", "get_review_comments", "get_reviews", "get_comments"],
          description: "Action to perform",
        },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["owner", "repo", "pullNumber", "method"],
    },
  },

  // Search tools
  {
    name: "search_code",
    description: "Search code across GitHub repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query using GitHub code search syntax" },
        sort: { type: "string", description: "Sort field (indexed only)" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "search_pull_requests",
    description: "Search for pull requests across GitHub",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query using GitHub search syntax" },
        owner: { type: "string", description: "Repository owner filter" },
        repo: { type: "string", description: "Repository name filter" },
        sort: { type: "string", enum: ["comments", "reactions", "created", "updated"], description: "Sort field" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "search_repositories",
    description: "Search GitHub repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        sort: { type: "string", enum: ["stars", "forks", "help-wanted-issues", "updated"], description: "Sort field" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
        minimal_output: { type: "boolean", description: "Return minimal info (default: true)", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "search_users",
    description: "Search GitHub users",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        sort: { type: "string", enum: ["followers", "repositories", "joined"], description: "Sort field" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
        page: { type: "number", description: "Page number for pagination", minimum: 1 },
        perPage: { type: "number", description: "Results per page (max 100)", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
  },
];

// Inject `compact` parameter into every tool schema
export const TOOLS: Tool[] = TOOL_DEFS.map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...(tool.inputSchema as any).properties,
      compact: {
        type: "boolean",
        description:
          "Return compact summary (default: true). Set false for full API response.",
        default: true,
      },
    },
  },
}));

/**
 * Route tool calls to the appropriate handler
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    // Commit tools
    case "get_commit":
      return commits.getCommit(args);
    case "list_commits":
      return commits.listCommits(args);

    // File tools
    case "get_file_contents":
      return files.getFileContents(args);

    // User tools
    case "get_me":
      return user.getMe();
    case "get_teams":
      return user.getTeams(args);
    case "get_team_members":
      return user.getTeamMembers(args);

    // Branch tools
    case "list_branches":
      return branches.listBranches(args);

    // Pull request tools
    case "list_pull_requests":
      return pullRequests.listPullRequests(args);
    case "pull_request_read":
      return pullRequests.pullRequestRead(args);

    // Search tools
    case "search_code":
      return search.searchCode(args);
    case "search_pull_requests":
      return search.searchPullRequests(args);
    case "search_repositories":
      return search.searchRepositories(args);
    case "search_users":
      return search.searchUsers(args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
