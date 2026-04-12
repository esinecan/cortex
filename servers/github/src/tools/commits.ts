/**
 * Commit-related tools: get_commit, list_commits
 */

import { execGhApi } from "../core/executor.js";
import type { GetCommitInput, ListCommitsInput } from "../core/types.js";

export async function getCommit(args: Record<string, unknown>): Promise<unknown> {
  const { owner, repo, sha, include_diff = true, page, perPage } = args as unknown as GetCommitInput;

  if (!owner || !repo || !sha) {
    throw new Error("owner, repo, and sha are required");
  }

  const endpoint = `/repos/${owner}/${repo}/commits/${sha}`;
  const commit = await execGhApi<any>(endpoint);

  // If include_diff is false, strip the file details
  if (!include_diff && commit.files) {
    delete commit.files;
  }

  return commit;
}

export async function listCommits(args: Record<string, unknown>): Promise<unknown> {
  const { owner, repo, sha, author, page = 1, perPage = 30 } = args as unknown as ListCommitsInput;

  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  let endpoint = `/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}`;
  
  if (sha) {
    endpoint += `&sha=${encodeURIComponent(sha)}`;
  }
  if (author) {
    endpoint += `&author=${encodeURIComponent(author)}`;
  }

  return execGhApi<unknown>(endpoint);
}
