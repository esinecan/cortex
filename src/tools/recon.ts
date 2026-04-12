import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';

function success(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Recon tools: structured investigation prompts and finding checkpoints.
 * Guides the agent through ticket context, code search, and knowledge base queries.
 */
export function registerReconTools(server: McpServer, state: StateManager): void {
  const sweepHandle = server.registerTool(
    'recon_sweep',
    {
      description: 'Start a reconnaissance sweep. Returns a structured prompt for what to investigate using code search, documentation, and git history.',
      inputSchema: {
        ticket_id: z.string().optional().describe('Issue or ticket ID in your issue tracker (e.g. PROJ-123)'),
        repo: z.string().optional().describe('Repository name to focus on'),
        topic: z.string().optional().describe('Free-text topic to investigate'),
      },
    },
    async (args) => {
      const lines: string[] = ['## Recon Sweep', ''];

      if (args.ticket_id) {
        lines.push(`### 1. Ticket Context: ${args.ticket_id}`);
        lines.push(`- Look up ${args.ticket_id} in your issue tracker (could be an external tool paired with cortex)`);
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
        lines.push(`- Search your documentation platform for "${args.topic}" (could be an external tool paired with cortex)`);
        lines.push(`- Search your knowledge base or past session notes for "${args.topic}" (could be an external tool paired with cortex)`);
        lines.push(`- Grep codebase for related patterns`);
        lines.push('');
      }

      lines.push('### Final');
      lines.push('Save findings via `recon_checkpoint` before moving on.');

      return success(lines.join('\n'));
    },
  );
  state.registerTool('recon_sweep', 'recon', sweepHandle);

  const checkpointHandle = server.registerTool(
    'recon_checkpoint',
    {
      description: 'Save a recon finding to the active task. Enforces: findings must be saved, not just observed.',
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
        return success(`Checkpoint (task error: ${result.error}):\n\n${args.summary}`);
      }
      return success(`Checkpoint saved to task ${taskId}:\n\n${args.summary}`);
    },
  );
  state.registerTool('recon_checkpoint', 'recon', checkpointHandle);
}
