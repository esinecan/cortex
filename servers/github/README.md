# gh-mcp

A lightweight MCP (Model Context Protocol) server that wraps the `gh` CLI to provide read-only GitHub operations with structured JSON responses.

## Purpose

This server provides the same functionality as the official GitHub MCP server but:
- Uses `gh` CLI under the hood (leverages existing authentication)
- Read-only operations only (no mutations)
- Excludes issue tracking
- Lightweight and simple to understand

## Features

Read-only GitHub operations via MCP tools:

| Tool | Description | gh CLI Equivalent |
|------|-------------|-------------------|
| `get_commit` | Get commit details with diff | `gh api /repos/.../commits/...` |
| `get_file_contents` | Get file/directory contents | `gh api /repos/.../contents/...` |
| `get_me` | Get authenticated user info | `gh api /user` |
| `get_team_members` | Get team member usernames | `gh api /orgs/.../teams/.../members` |
| `get_teams` | Get user's team memberships | `gh api /user/teams` |
| `list_branches` | List repository branches | `gh api /repos/.../branches` |
| `list_commits` | List repository commits | `gh api /repos/.../commits` |
| `list_pull_requests` | List PRs in a repository | `gh pr list --json ...` |
| `pull_request_read` | Get PR details, diff, reviews, etc. | `gh pr view`, `gh pr diff` |
| `search_code` | Search code across GitHub | `gh search code` |
| `search_pull_requests` | Search PRs across GitHub | `gh search prs` |
| `search_repositories` | Search repositories | `gh search repos` |
| `search_users` | Search GitHub users | `gh api search/users` |

## Installation

```bash
# Clone and install
git clone git@github.com:esinecan/gh-mcp.git
cd gh-mcp
npm install
npm run build
```

## Configuration

Add to your MCP config (e.g., VS Code `mcp.json`):

```json
{
  "servers": {
    "gh-mcp": {
      "command": "node",
      "args": ["/path/to/gh-mcp/dist/mcp/server.js"]
    }
  }
}
```

## Prerequisites

- Node.js 18+
- `gh` CLI installed and authenticated (`gh auth login`)

## License

MIT

## Cortex integration

When proxied by [cortex](../../README.md), all 13 tools are available in the `recon` and `review` states.
