export const CORTEX_INSTRUCTIONS = `
# Cortex -- Executive Function Layer

Cortex manages your workflow state and persistent tasks across sessions.
It ships with default proxy servers (Playwright, Brave Search, GitHub, Commands)
and is designed so you can add or swap MCP servers via mcp-servers.yaml.

## Always-On Tools
- \`task_create\`, \`task_update\`, \`task_list\`, \`task_get\`, \`task_context\` -- persistent cross-session tasks
- \`current_state\`, \`enter_state\`, \`exit_state\` -- workflow state management
- \`free_explore\`, \`exit_free\` -- open-ended mode, or escape hatch from a structured state
- \`suggest_state\` -- recommend a state based on your intent

## States
Each state makes relevant tools visible and hides irrelevant ones.

| State | Purpose |
|-------|---------|
| base | Default. Task management and state selection. |
| recon | Read-only exploration -- understand before acting. |
| plan | Structured planning -- draft, validate, approve. |
| implement | Active coding -- write, test, checkpoint. |
| debug | Debugging -- hypotheses, logs, DB queries, distributed tracing. |
| validate | Verification (L1->L2->L3). Local checks, flow verification, browser E2E. |
| review | Self-review and PR prep. |
| browse | Focus state. Browser only. |
| free | Escape hatch. All tools. |

## Pathways
Guided workflows -- named sequences of states with step-by-step guidance.

| Pathway | Flow | When to use |
|---------|------|-------------|
| golden | recon -> plan -> implement -> validate -> review | Feature development, tickets |
| investigation | debug -> implement -> validate -> review | Bugs, errors |
| knowledge | recon -> exit | Quick domain questions |
| e2e_verify | validate | Standalone E2E verification |
| code_review | recon -> review | Reviewing someone else's PR |
| free_roam | free | Open-ended questions, meta-tasks |
| introspect | recon -> plan -> implement -> validate | Self-audit cortex internals |

Create a task with a pathway: \`task_create(title, pathway="golden")\`

## Pluggability
Cortex proxies external MCP servers defined in mcp-servers.yaml. Each server declares
a \`discovery_state\` that determines when its tools become visible. To add your own
server (observability, database, CI, etc.), add an entry to mcp-servers.yaml and its
tools will automatically appear in the appropriate state.

## Session Start
1. \`task_list\` -- check what is active from previous sessions
2. \`task_context(id)\` -- reconstruct context for an existing task
3. \`task_create(title, pathway="...")\` -- or start a new task

## Important
- Tasks survive across sessions. Always check \`task_list\` at session start.
- \`task_context\` is how you pick up where the last session left off. Paginated (50 findings/page).
`.trim();
