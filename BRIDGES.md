# Bridge Tools

Cortex ships with generic guidance in every state. The native tools say things like
"use your observability platform" or "query your database" -- these are the seams
where you plug in your actual stack.

A bridge is any MCP server wired into cortex via `mcp-servers.yaml`. Set its
`discovery_state` and its tools appear in the right state automatically.

## Anything can be an MCP server

If it has an interface, it can be wrapped in an MCP layer and plugged into cortex.
Database clients, observability platforms, CI pipelines -- obvious candidates. But
think laterally. A Playwright script that logs into your staging environment. A
joystick driver. A hardware test rig. A Slack bot. A PDF parser. If the agent
needs to interact with it during a workflow state, wrap it and plug it in.

The MCP spec is thin: expose tools with JSON Schema inputs, return text/image
content. That's it. The cortex side is one YAML entry.

## Example bridges

### Observability (debug state)

The debug tools give guidance but can't query logs. Plug in your platform:

```yaml
# mcp-servers.yaml — add under external: or vendored:
datadog:
  command: node
  args: [path/to/datadog-mcp/server.js]
  discovery_state: debug
  curated_tools:
    - dd_search_logs
    - dd_top_values
    - dd_fetch_log
    - dd_trace_logs

# Grafana alternative
grafana:
  command: npx
  args: [-y, "@grafana/mcp-server"]
  discovery_state: debug
  curated_tools:
    - search_dashboards
    - query_loki
    - query_prometheus
```

### Database (debug state)

`debug_db_query` tells you what to look for. A DB bridge does the looking:

```yaml
mongodb:
  command: node
  args: [path/to/mongo-mcp/server.js]
  discovery_state: debug
  curated_tools:
    - mongo_query
    - mongo_aggregate

# Or PostgreSQL
postgres:
  command: node
  args: [path/to/pg-mcp/server.js]
  discovery_state: debug
  curated_tools:
    - pg_query
    - pg_explain
```

### CI/CD (review state)

`review_checklist` can't check your pipeline. Plug in your CI:

```yaml
circleci:
  command: npx
  args: [-y, "@circleci/mcp-server-circleci@latest"]
  discovery_state: review
  curated_tools:
    - get_build_failure_logs
    - get_latest_pipeline_status
    - find_flaky_tests

# GitHub Actions alternative
gh-actions:
  command: node
  args: [path/to/gh-actions-mcp/server.js]
  discovery_state: review
  curated_tools:
    - list_workflow_runs
    - get_workflow_logs
```

### Issue tracker (recon state)

`recon_sweep` says "look up the ticket in your issue tracker." Plug one in:

```yaml
atlassian:
  command: uv
  args: [run, --directory, path/to/mcp-atlassian, mcp-atlassian]
  discovery_state: recon
  curated_tools:
    - jira_get_issue
    - jira_search
    - confluence_search
    - confluence_get_page

# Linear alternative
linear:
  command: npx
  args: [-y, "@linear/mcp-server"]
  discovery_state: recon
  curated_tools:
    - get_issue
    - search_issues
```

### Kubernetes (debug state)

For cluster health checks alongside your observability tools:

```yaml
kubectl:
  command: node
  args: [path/to/kubectl-mcp/server.js]
  discovery_state: debug
  curated_tools:
    - kubectl_get_pods
    - kubectl_logs
    - kubectl_describe
```

### Custom automation (implement state)

Wrap any script or automation as an MCP server. Deployment scripts,
seed data generators, environment provisioners:

```yaml
my-deploy:
  command: node
  args: [./scripts/deploy-mcp.js]
  discovery_state: implement
  curated_tools:
    - deploy_staging
    - rollback_staging
    - seed_test_data
```

## Multi-state visibility

A tool can only have one `discovery_state`. If you need it in multiple states,
use `free_explore` to escape temporarily, or `cortex_discover` to enable
individual tools by name in free explore mode.

## Building a bridge

1. Write an MCP server (stdio transport is simplest)
2. Add it to `mcp-servers.yaml` with `discovery_state` matching where it's useful
3. List `curated_tools` -- only these show in the state; others are discoverable via free explore
4. Restart cortex

The native tools' generalized guidance ("could be an external tool paired with
cortex") marks exactly where each bridge fits. Follow the breadcrumbs.
