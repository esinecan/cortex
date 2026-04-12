import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond } from '../respond.js';

/**
 * Plan tools: draft, validate, and approve implementation plans.
 * plan_approve transitions directly to the implement state.
 */
export function registerPlanTools(server: McpServer, state: StateManager): void {
  const draftHandle = server.registerTool(
    'plan_draft',
    {
      description: 'Create a structured implementation plan. Persists to the active task.',
      inputSchema: {
        goal: z.string().describe('What the plan aims to achieve'),
        sections: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(
              z.object({
                title: z.string(),
                content: z.string(),
              }),
            ),
          )
          .describe('Plan sections as [{title, content}]'),
      },
    },
    async (args) => {
      const lines = [`## Plan: ${args.goal}`, ''];
      for (const section of args.sections as Array<{ title: string; content: string }>) {
        lines.push(`### ${section.title}`);
        lines.push(section.content);
        lines.push('');
      }

      const planText = lines.join('\n');
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: `[plan] ${args.goal}\n${planText}` }, 'plan');
      }

      return respond(
        state,
        planText,
        '`plan_validate` to check against actual code, then `plan_approve` to proceed.',
      );
    },
  );
  state.registerTool('plan_draft', 'plan', draftHandle);

  const validateHandle = server.registerTool(
    'plan_validate',
    {
      description:
        'Validate the current plan against actual code. Checks that referenced files, functions, and patterns exist.',
      inputSchema: {
        files: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()),
          )
          .describe('File paths referenced in the plan to verify'),
        functions: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()).optional(),
          )
          .describe('Function/class names referenced in the plan to verify'),
      },
    },
    async (args) => {
      const lines = ['## Plan Validation', '', 'Verify the following exist in the codebase:', ''];

      lines.push('### Files');
      for (const f of args.files as string[]) {
        lines.push(`- [ ] \`${f}\``);
      }

      if (args.functions && (args.functions as string[]).length > 0) {
        lines.push('', '### Functions/Classes');
        for (const fn of args.functions as string[]) {
          lines.push(`- [ ] \`${fn}\``);
        }
      }

      lines.push('', 'Use Read/Grep to verify each item. Then call `plan_approve` if valid.');
      lines.push('', 'Consider an adversarial review of the plan before approval.');

      return respond(state, lines.join('\n'), '`plan_approve` when all items verified.');
    },
  );
  state.registerTool('plan_validate', 'plan', validateHandle);

  const approveHandle = server.registerTool(
    'plan_approve',
    {
      description: 'Mark the plan as approved and transition to implement state.',
    },
    async () => {
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(
          taskId,
          { findings: '[plan approved] Transitioning to implement state.' },
          'plan',
        );
      }
      state.enterState('implement');
      return respond(
        state,
        'Plan approved. Transitioned to **implement** state.',
        '`impl_checkpoint` to record progress, `impl_test` to verify, `impl_stuck` if blocked.',
      );
    },
  );
  state.registerTool('plan_approve', 'plan', approveHandle);
}
