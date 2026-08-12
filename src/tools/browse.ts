import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond } from '../respond.js';

/**
 * Browse tools: journaling companion for the proxied Playwright server.
 * Records URLs, purpose, and findings to the active task's audit trail.
 */
export function registerBrowseTools(server: McpServer, state: StateManager): void {
  const captureHandle = server.registerTool(
    'browse_capture',
    {
      description:
        'Record a web research finding. Maintains a breadcrumb trail of what was browsed and why.',
      inputSchema: {
        url: z.string().describe('URL that was visited'),
        purpose: z.string().describe('Why this page was visited'),
        finding: z.string().optional().describe('What was found (optional -- can add later)'),
      },
    },
    async (args) => {
      const finding = `[browse] ${args.url}\nPurpose: ${args.purpose}${args.finding ? `\nFound: ${args.finding}` : ''}`;

      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'browse');
      }

      return respond(
        state,
        `Browse captured: ${args.url}\n\n**Purpose:** ${args.purpose}${args.finding ? `\n**Finding:** ${args.finding}` : ''}`,
        'Continue browsing, or `exit_state` when research is complete.',
      );
    },
  );
  state.registerTool('browse_capture', 'browse', captureHandle);
}
