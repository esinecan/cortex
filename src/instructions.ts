import { getPathwayNames, getPathway } from './pathways.js';

function renderPathwaysTable(): string {
  const names = getPathwayNames();
  if (names.length === 0) return '*No pathways defined.*';
  const lines = ['| Pathway | Flow | When to use |', '|---------|------|-------------|'];
  for (const name of names) {
    const pw = getPathway(name);
    if (!pw) continue;
    const flow = pw.sequence.join(' -> ');
    const when = pw.description.replace(/\|/g, '\\|');
    lines.push(`| ${name} | ${flow} | ${when} |`);
  }
  return lines.join('\n');
}

/**
 * Build the cortex instructions string. Must be called AFTER loadPathways()
 * so the pathways table reflects pathways.yaml and can't drift.
 */
export function buildInstructions(): string {
  return `
# Cortex -- Executive Function Layer

## Start Here
1. \`task_list\` -- check for active tasks from previous sessions
2. If resuming: \`task_context(id)\` to pick up where you left off
3. If new work: \`task_create(title, pathway="...")\` to start

Tasks survive across sessions. Always check \`task_list\` first.

## Pathways
Named storylines that guide you through states:

${renderPathwaysTable()}

Create a task with a pathway: \`task_create(title, pathway="golden")\`

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

## Always Available
These tools work in every state:
- \`task_create\`, \`task_update\`, \`task_list\`, \`task_context\` -- persistent tasks
- \`enter_state\`, \`exit_state\`, \`current_state\` -- navigation
- \`free_explore\` / \`exit_free\` -- escape hatch
- \`suggest_state\` -- not sure where to go? Describe your intent
- \`think\` -- structured scratchpad. See "Think Before You Act" below.
- \`crystallize_check\` -- find repeated work that should become a bridge or pathway. Pass a signature to dig into that bucket's findings.
- \`pathway_usage_audit\` -- find static pathways that have gone cold and are archival candidates.
- \`pathway_deviation_audit\` -- find prescribed states that get skipped within live pathways (design signal).

## Think Before You Act (the \`think\` tool)
Before any non-trivial action -- planning, committing to an interpretation,
choosing between approaches, declaring something done -- call \`think\` to
record your reasoning. It is always available, in every state.

- One thought per call. Number them. Adjust totalThoughts as you go.
- Use \`isRevision\` + \`revisesThought\` when you change your mind.
- Use \`branchFromThought\` + \`branchId\` to explore alternatives without
  losing the original line of reasoning.
- Set \`nextThoughtNeeded=false\` only when you have an answer you would
  actually act on.

The catch: this only helps if you actually use it. Skipping the think step
because you "already know" is the failure mode it exists to prevent.

## Pluggability
Cortex proxies external MCP servers (Playwright, Brave Search, GitHub, etc.).
Add your own via mcp-servers.yaml -- tools appear automatically in the right state.
`.trim();
}
