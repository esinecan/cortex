/**
 * Branch tools: list_branches
 */

import { execGhApi } from "../core/executor.js";
import type { ListBranchesInput } from "../core/types.js";

export async function listBranches(args: Record<string, unknown>): Promise<unknown> {
  const { owner, repo, page = 1, perPage = 30 } = args as unknown as ListBranchesInput;

  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  return execGhApi<unknown>(`/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`);
}
