export const CORTEX_INSTRUCTIONS = `
# Cortex -- Executive Function Layer

## Start Here
1. \`task_list\` -- check for active tasks from previous sessions
2. If resuming: \`task_context(id)\` to pick up where you left off
3. If new work: \`task_create(title, pathway="golden")\` to start

Tasks survive across sessions. Always check \`task_list\` first.

## How It Works
Cortex is a state machine. You are always in one **state** (chapter).
Each state shows you different tools and constraints. Transition with \`enter_state\`.

| State | You are... | Key tools |
|-------|-----------|-----------|
| base | Choosing what to do | \`suggest_state\`, \`task_create\` |
| recon | Understanding the problem | \`recon_sweep\`, \`recon_checkpoint\` |
| plan | Designing the approach | \`plan_draft\`, \`plan_validate\`, \`plan_approve\` |
| implement | Writing code | \`impl_checkpoint\`, \`impl_test\`, \`impl_stuck\` |
| debug | Investigating a bug | \`debug_hypothesis\`, \`debug_root_cause\` |
| validate | Verifying it works (L1->L2->L3) | \`validate_prerequisites\`, \`validate_advance\` |
| review | Preparing for PR | \`review_diff_summary\`, \`review_simulate\` |
| browse | Focused web research | \`browse_capture\` + Playwright tools |
| free | Escape hatch -- all tools | \`cortex_discover\` to find anything |

## Pathways
Named storylines that guide you through states:

| Pathway | Flow | Use for |
|---------|------|---------|
| golden | recon -> plan -> implement -> validate -> review | Features |
| investigation | debug -> implement -> validate -> review | Bugs |
| knowledge | recon | Quick questions |
| e2e_verify | validate (L1->L2->L3) | E2E testing |
| code_review | recon -> review | Reviewing PRs |
| free_roam | free | Open-ended work |

## Always Available
These tools work in every state:
- \`task_create\`, \`task_update\`, \`task_list\`, \`task_context\` -- persistent tasks
- \`enter_state\`, \`exit_state\`, \`current_state\` -- navigation
- \`free_explore\` / \`exit_free\` -- escape hatch
- \`suggest_state\` -- not sure where to go? Describe your intent

## Pluggability
Cortex proxies external MCP servers (Playwright, Brave Search, GitHub, etc.).
Add your own via mcp-servers.yaml -- tools appear automatically in the right state.
`.trim();
