/**
 * TypeScript types for gh-mcp tool inputs and outputs
 */

// Common pagination params
export interface PaginationParams {
  page?: number;
  perPage?: number;
}

// ============ get_commit ============
export interface GetCommitInput extends PaginationParams {
  owner: string;
  repo: string;
  sha: string;
  include_diff?: boolean;
}

// ============ get_file_contents ============
export interface GetFileContentsInput {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
  sha?: string;
}

// ============ get_me ============
// No input params

// ============ get_team_members ============
export interface GetTeamMembersInput {
  org: string;
  team_slug: string;
}

// ============ get_teams ============
export interface GetTeamsInput {
  user?: string;
}

// ============ list_branches ============
export interface ListBranchesInput extends PaginationParams {
  owner: string;
  repo: string;
}

// ============ list_commits ============
export interface ListCommitsInput extends PaginationParams {
  owner: string;
  repo: string;
  sha?: string;
  author?: string;
}

// ============ list_pull_requests ============
export interface ListPullRequestsInput extends PaginationParams {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  head?: string;
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
}

// ============ pull_request_read ============
export type PullRequestMethod = 
  | "get" 
  | "get_diff" 
  | "get_status" 
  | "get_files" 
  | "get_review_comments" 
  | "get_reviews" 
  | "get_comments";

export interface PullRequestReadInput extends PaginationParams {
  owner: string;
  repo: string;
  pullNumber: number;
  method: PullRequestMethod;
}

// ============ search_code ============
export interface SearchCodeInput extends PaginationParams {
  query: string;
  sort?: string;
  order?: "asc" | "desc";
}

// ============ search_pull_requests ============
export interface SearchPullRequestsInput extends PaginationParams {
  query: string;
  owner?: string;
  repo?: string;
  sort?: "comments" | "reactions" | "created" | "updated";
  order?: "asc" | "desc";
}

// ============ search_repositories ============
export interface SearchRepositoriesInput extends PaginationParams {
  query: string;
  sort?: "stars" | "forks" | "help-wanted-issues" | "updated";
  order?: "asc" | "desc";
  minimal_output?: boolean;
}

// ============ search_users ============
export interface SearchUsersInput extends PaginationParams {
  query: string;
  sort?: "followers" | "repositories" | "joined";
  order?: "asc" | "desc";
}
