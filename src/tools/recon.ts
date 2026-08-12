import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond, success } from '../respond.js';

/**
 * Recon tools: structured investigation prompts and finding checkpoints.
 * Guides the agent through ticket context, code search, and knowledge base queries.
 */
export function registerReconTools(server: McpServer, state: StateManager): void {
  const sweepHandle = server.registerTool(
    'recon_sweep',
    {
      description:
        'Returns a structured investigation plan for a ticket, repo, or topic. Does not execute anything directly — follow the checklist with your search/read tools.',
      inputSchema: {
        ticket_id: z
          .string()
          .optional()
          .describe('Issue or ticket ID in your issue tracker (e.g. PROJ-123)'),
        repo: z.string().optional().describe('Repository name to focus on'),
        topic: z.string().optional().describe('Free-text topic to investigate'),
      },
    },
    async (args) => {
      const lines: string[] = ['## Recon Sweep', ''];

      if (args.ticket_id) {
        lines.push(`### 1. Ticket Context: ${args.ticket_id}`);
        lines.push(
          `- Look up ${args.ticket_id} in your issue tracker (could be an external tool paired with cortex)`,
        );
        lines.push(`- Search documentation for ${args.ticket_id} acceptance criteria and context`);
        lines.push(`- Check git log for commits referencing ${args.ticket_id}`);
        lines.push('');
      }

      if (args.repo) {
        lines.push(`### ${args.ticket_id ? '2' : '1'}. Code Context: ${args.repo}`);
        lines.push(`- Check for open PRs in ${args.repo} (use GitHub tools or \`gh pr list\`)`);
        lines.push(`- Recent commits: \`git log --oneline -20\` in the repo`);
        lines.push(`- Read README / docs/ in the repo for conventions`);
        lines.push('');
      }

      if (args.topic) {
        lines.push(`### Topic: ${args.topic}`);
        lines.push(
          `- Search your documentation platform for "${args.topic}" (could be an external tool paired with cortex)`,
        );
        lines.push(
          `- Search your knowledge base or past session notes for "${args.topic}" (could be an external tool paired with cortex)`,
        );
        lines.push(`- Grep codebase for related patterns`);
        lines.push('');
      }

      lines.push('### Final');
      lines.push('Save findings via `recon_checkpoint` before moving on.');

      return respond(
        state,
        lines.join('\n'),
        'Execute the checklist above, then `recon_checkpoint` to save findings.',
      );
    },
  );
  state.registerTool('recon_sweep', 'recon', sweepHandle);

  const checkpointHandle = server.registerTool(
    'recon_checkpoint',
    {
      description:
        'Save a recon finding to the active task. Enforces: findings must be saved, not just observed.',
      inputSchema: {
        summary: z.string().describe('What you found during reconnaissance'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      if (!taskId) {
        return success(`Checkpoint saved (no active task):\n\n${args.summary}`);
      }

      const result = updateTask(taskId, { findings: args.summary }, 'recon');
      if (result.error) {
        return respond(state, `Checkpoint (task error: ${result.error}):\n\n${args.summary}`);
      }
      return respond(
        state,
        `Checkpoint saved to task ${taskId}:\n\n${args.summary}`,
        'Continue investigating, or `enter_state("plan")` when you understand the problem.',
      );
    },
  );
  state.registerTool('recon_checkpoint', 'recon', checkpointHandle);
}
