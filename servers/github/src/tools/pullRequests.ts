/**
 * Pull request tools: list_pull_requests, pull_request_read
 */

import { execGh, execGhApi, execGhJson } from "../core/executor.js";
import type { ListPullRequestsInput, PullRequestReadInput } from "../core/types.js";

export async function listPullRequests(args: Record<string, unknown>): Promise<unknown> {
  const { 
    owner, repo, state = "open", head, base, sort, direction, 
    page = 1, perPage = 30 
  } = args as unknown as ListPullRequestsInput;

  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  // Use gh pr list for better formatting
  const ghArgs = [
    "pr", "list",
    "--repo", `${owner}/${repo}`,
    "--state", state,
    "--limit", String(perPage),
    "--json", "number,title,state,author,createdAt,updatedAt,url,headRefName,baseRefName,isDraft,mergeable",
  ];

  if (head) ghArgs.push("--head", head);
  if (base) ghArgs.push("--base", base);

  return execGhJson<unknown>(ghArgs);
}

export async function pullRequestRead(args: Record<string, unknown>): Promise<unknown> {
  const { owner, repo, pullNumber, method, page = 1, perPage = 30 } = args as unknown as PullRequestReadInput;

  if (!owner || !repo || !pullNumber || !method) {
    throw new Error("owner, repo, pullNumber, and method are required");
  }

  switch (method) {
    case "get":
      return execGhJson<unknown>([
        "pr", "view", String(pullNumber),
        "--repo", `${owner}/${repo}`,
        "--json", "number,title,body,state,author,createdAt,updatedAt,url,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,isDraft,reviewDecision",
      ]);

    case "get_diff":
      const diff = await execGh([
        "pr", "diff", String(pullNumber),
        "--repo", `${owner}/${repo}`,
      ]);
      return { diff };

    case "get_status":
      // Get the PR first to find head SHA
      const pr = await execGhJson<{ headRefOid: string }>([
        "pr", "view", String(pullNumber),
        "--repo", `${owner}/${repo}`,
        "--json", "headRefOid",
      ]);
      return execGhApi<unknown>(`/repos/${owner}/${repo}/commits/${pr.headRefOid}/status`);

    case "get_files":
      return execGhApi<unknown>(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`
      );

    case "get_review_comments":
      return execGhApi<unknown>(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=${perPage}&page=${page}`
      );

    case "get_reviews":
      return execGhApi<unknown>(
        `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=${perPage}&page=${page}`
      );

    case "get_comments":
      // Issue comments (not review comments)
      return execGhApi<unknown>(
        `/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=${perPage}&page=${page}`
      );

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
