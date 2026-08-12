import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond } from '../respond.js';

/**
 * Implement tools: progress checkpoints, test recording, and blocker signaling.
 * All findings persist to the active task for cross-session continuity.
 */
export function registerImplementTools(server: McpServer, state: StateManager): void {
  const checkpointHandle = server.registerTool(
    'impl_checkpoint',
    {
      description: 'Record implementation progress. Persists to the active task with file list.',
      inputSchema: {
        description: z.string().describe('What was done in this checkpoint'),
        files_changed: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()).optional(),
          )
          .describe('Files modified in this checkpoint'),
      },
    },
    async (args) => {
      const files = args.files_changed as string[] | undefined;
      const fileList = files?.length ? `\nFiles: ${files.join(', ')}` : '';
      const finding = `[impl] ${args.description}${fileList}`;

      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'implement');
      }

      return respond(
        state,
        `Checkpoint saved.${fileList}\n\n${args.description}`,
        'Continue implementing, `impl_test` to verify, or `impl_stuck` if blocked.',
      );
    },
  );
  state.registerTool('impl_checkpoint', 'implement', checkpointHandle);

  const testHandle = server.registerTool(
    'impl_test',
    {
      description: 'Run tests and record results to the active task.',
      inputSchema: {
        command: z
          .string()
          .optional()
          .describe('Test command to run (guidance only -- execute via run_command or Bash)'),
        result: z.enum(['pass', 'fail', 'partial']).optional().describe('Test result to record'),
        details: z.string().optional().describe('Test output summary'),
      },
    },
    async (args) => {
      const lines: string[] = ['## Test Checkpoint'];

      if (args.command) {
        lines.push('', `Run: \`${args.command}\``);
      }

      if (args.result) {
        const emoji = args.result === 'pass' ? 'PASS' : args.result === 'fail' ? 'FAIL' : 'PARTIAL';
        lines.push('', `Result: **${emoji}**`);
        if (args.details) lines.push('', args.details);

        const taskId = state.getActiveTaskId();
        if (taskId) {
          updateTask(
            taskId,
            { findings: `[test:${args.result}] ${args.details || args.command || 'tests run'}` },
            'implement',
          );
        }
      } else {
        lines.push(
          '',
          'Execute the test, then call `impl_test` again with `result` and `details`.',
        );
      }

      return respond(state, lines.join('\n'));
    },
  );
  state.registerTool('impl_test', 'implement', testHandle);

  const stuckHandle = server.registerTool(
    'impl_stuck',
    {
      description:
        'Signal that you are blocked. Suggests reasoning tools or state switch to debug.',
      inputSchema: {
        description: z.string().describe('What is blocking progress?'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: `[blocked] ${args.description}` }, 'implement');
      }

      return respond(
        state,
        [
          `## Blocked: ${args.description}`,
          '',
          '### Options',
          '1. **Reason through it**: Use your reasoning tool (e.g. extended thinking or a dedicated reasoning MCP) to work through the blocker',
          '2. **Debug state**: `enter_state("debug")` for progressive investigation',
          "3. **Free explore**: `free_explore` if the problem doesn't fit a state",
          '4. **Ask the user**: If you need human judgment or context',
        ].join('\n'),
      );
    },
  );
  state.registerTool('impl_stuck', 'implement', stuckHandle);
}
