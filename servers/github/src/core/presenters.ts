/**
 * Compact response presenters for gh-mcp tools.
 *
 * Each presenter transforms a raw GitHub API response into a minimal,
 * context-efficient shape — the MCP equivalent of gh's --jq flag.
 * Applied when compact=true (default). Set compact=false to bypass.
 */

type Presenter = (data: unknown, args?: Record<string, unknown>) => unknown;

// ============================================================================
// COMMIT PRESENTERS
// ============================================================================

function presentCommitList(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((c: any) => ({
    sha: c.sha?.substring(0, 7),
    message: c.commit?.message?.split("\n")[0],
    author: c.commit?.author?.name || c.author?.login,
    date: c.commit?.author?.date,
    url: c.html_url,
  }));
}

function presentCommit(data: unknown): unknown {
  const c = data as any;
  if (!c?.sha) return data;
  const result: any = {
    sha: c.sha?.substring(0, 7),
    message: c.commit?.message,
    author: c.commit?.author?.name || c.author?.login,
    date: c.commit?.author?.date,
    url: c.html_url,
  };
  if (c.stats) {
    result.stats = {
      additions: c.stats.additions,
      deletions: c.stats.deletions,
      total: c.stats.total,
    };
  }
  if (c.files) {
    result.files = c.files.map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }
  return result;
}

// ============================================================================
// BRANCH PRESENTER
// ============================================================================

function presentBranchList(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((b: any) => ({
    name: b.name,
    protected: b.protected,
    sha: b.commit?.sha?.substring(0, 7),
  }));
}

// ============================================================================
// SEARCH PRESENTERS
// ============================================================================

function presentSearchUsers(data: unknown): unknown {
  const d = data as any;
  if (!d?.items) return data;
  return {
    total_count: d.total_count,
    items: d.items.map((u: any) => ({
      login: u.login,
      type: u.type,
      url: u.html_url,
    })),
  };
}

// ============================================================================
// PULL REQUEST READ PRESENTER
// ============================================================================

function presentPullRequestRead(
  data: unknown,
  args?: Record<string, unknown>,
): unknown {
  const method = args?.method as string;
  if (!method) return data;

  switch (method) {
    case "get_files": {
      if (!Array.isArray(data)) return data;
      return data.map((f: any) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }));
    }
    case "get_review_comments":
    case "get_comments": {
      if (!Array.isArray(data)) return data;
      return data.map((c: any) => ({
        id: c.id,
        user: c.user?.login,
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
        ...(c.path ? { path: c.path, line: c.line } : {}),
        url: c.html_url,
      }));
    }
    case "get_reviews": {
      if (!Array.isArray(data)) return data;
      return data.map((r: any) => ({
        id: r.id,
        user: r.user?.login,
        state: r.state,
        body: r.body,
        submitted_at: r.submitted_at,
      }));
    }
    case "get_status": {
      const s = data as any;
      if (!s?.statuses) return data;
      return {
        state: s.state,
        total_count: s.total_count,
        statuses: s.statuses.map((st: any) => ({
          context: st.context,
          state: st.state,
          description: st.description,
          target_url: st.target_url,
        })),
      };
    }
    default:
      // "get" and "get_diff" — already compact enough or custom-shaped
      return data;
  }
}

// ============================================================================
// REGISTRY
// ============================================================================

const PRESENTERS: Record<string, Presenter> = {
  list_commits: presentCommitList,
  get_commit: presentCommit,
  list_branches: presentBranchList,
  search_users: presentSearchUsers,
  pull_request_read: presentPullRequestRead,
};

/**
 * Apply compact presenter if one exists for the tool.
 * Returns original data unchanged if no presenter is registered.
 */
export function presentResponse(
  toolName: string,
  data: unknown,
  args?: Record<string, unknown>,
): unknown {
  const presenter = PRESENTERS[toolName];
  if (!presenter) return data;
  return presenter(data, args);
}
