/**
 * Search tools: search_code, search_pull_requests, search_repositories, search_users
 */

import { execGhJson, execGhApi } from "../core/executor.js";
import type { 
  SearchCodeInput, 
  SearchPullRequestsInput, 
  SearchRepositoriesInput, 
  SearchUsersInput 
} from "../core/types.js";

export async function searchCode(args: Record<string, unknown>): Promise<unknown> {
  const { query, sort, order, page = 1, perPage = 30 } = args as unknown as SearchCodeInput;

  if (!query) {
    throw new Error("query is required");
  }

  const ghArgs = [
    "search", "code", query,
    "--json", "repository,path,url",
    "--limit", String(perPage),
  ];

  return execGhJson<unknown>(ghArgs);
}

export async function searchPullRequests(args: Record<string, unknown>): Promise<unknown> {
  const { query, owner, repo, sort, order, page = 1, perPage = 30 } = args as unknown as SearchPullRequestsInput;

  if (!query) {
    throw new Error("query is required");
  }

  let fullQuery = query;
  if (owner && repo) {
    fullQuery = `repo:${owner}/${repo} ${query}`;
  }

  const ghArgs = [
    "search", "prs", fullQuery,
    "--json", "number,title,state,repository,author,createdAt,url",
    "--limit", String(perPage),
  ];

  if (sort) ghArgs.push("--sort", sort);
  if (order) ghArgs.push("--order", order);

  return execGhJson<unknown>(ghArgs);
}

export async function searchRepositories(args: Record<string, unknown>): Promise<unknown> {
  const { query, sort, order, page = 1, perPage = 30, minimal_output = true } = args as unknown as SearchRepositoriesInput;

  if (!query) {
    throw new Error("query is required");
  }

  const jsonFields = minimal_output
    ? "fullName,description,url,stargazersCount,forksCount,language"
    : "fullName,name,owner,description,url,homepage,stargazersCount,forksCount,watchersCount,language,createdAt,updatedAt,pushedAt,isPrivate,isFork,isArchived,defaultBranch,license";

  const ghArgs = [
    "search", "repos", query,
    "--json", jsonFields,
    "--limit", String(perPage),
  ];

  if (sort) ghArgs.push("--sort", sort);
  if (order) ghArgs.push("--order", order);

  return execGhJson<unknown>(ghArgs);
}

export async function searchUsers(args: Record<string, unknown>): Promise<unknown> {
  const { query, sort, order, page = 1, perPage = 30 } = args as unknown as SearchUsersInput;

  if (!query) {
    throw new Error("query is required");
  }

  // gh search doesn't have users, use API directly
  let endpoint = `/search/users?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
  
  if (sort) endpoint += `&sort=${sort}`;
  if (order) endpoint += `&order=${order}`;

  return execGhApi<unknown>(endpoint);
}
