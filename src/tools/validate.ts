import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { success } from '../respond.js';

/**
 * Auto-detect prerequisite checks from a project directory. Universal checks
 * always apply; project checks are added when package.json scripts or a git
 * worktree are present. Used by validate_prerequisites when no checks are passed.
 */
export function defaultChecks(cwd: string): Array<{ name: string; check: string; fix: string }> {
  const checks = [{ name: 'Node version', check: 'node -v', fix: 'nvm use <version>' }];
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.test) {
        checks.push({
          name: 'Test suite',
          check: 'npm test',
          fix: 'fix failing tests before validating',
        });
      }
      if (pkg.scripts?.build) {
        checks.push({ name: 'Build', check: 'npm run build', fix: 'fix compile errors' });
      }
    } catch {
      /* unreadable package.json: skip project checks */
    }
  }
  if (existsSync(join(cwd, '.git'))) {
    checks.push({
      name: 'Clean git worktree',
      check: 'git status --porcelain | head -5',
      fix: 'commit or stash pending changes',
    });
  }
  return checks;
}

/**
 * Validate tools across three progressive levels:
 * L1 -- prerequisites and setup recipes,
 * L2 -- integration flow verification,
 * L3 -- browser automation and E2E (tools from Playwright proxy).
 */
export function registerValidateTools(server: McpServer, state: StateManager): void {
  // -- Level 1: Prerequisites and setup --

  const prerequisitesHandle = server.registerTool(
    'validate_prerequisites',
    {
      description:
        'Check infrastructure readiness for testing. Returns a checklist with commands to verify each component. Configure checks via CORTEX_PREREQS_FILE env var or pass inline.',
      inputSchema: {
        checks: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z
              .array(
                z.object({
                  name: z.string().describe('Component name'),
                  check: z.string().describe('Shell command to verify'),
                  fix: z.string().describe('Remediation command'),
                }),
              )
              .optional(),
          )
          .describe('Inline prerequisite checks. If omitted, returns a generic template.'),
      },
    },
    async (args) => {
      const checks = args.checks as Array<{ name: string; check: string; fix: string }> | undefined;

      if (checks && checks.length > 0) {
        const lines = [
          `## Prerequisites Check (${checks.length} items)`,
          '',
          'Run these commands to verify your environment:',
          '',
          '| Component | Check | Fix if failing |',
          '|-----------|-------|----------------|',
        ];

        for (const c of checks) {
          lines.push(`| ${c.name} | \`${c.check}\` | \`${c.fix}\` |`);
        }

        lines.push(
          '',
          'Run the checks via `run_command`, then `validate_advance` when ready for L2.',
        );

        const taskId = state.getActiveTaskId();
        if (taskId) {
          updateTask(
            taskId,
            { findings: `[validate:prerequisites] ${checks.length} checks` },
            'validate',
          );
        }

        return success(lines.join('\n'));
      }

      // No checks provided -- auto-detect from the current project
      const detected = defaultChecks(process.cwd());
      const detectedLines = [
        `## Prerequisites Check (auto-detected, ${detected.length} items)`,
        '',
        'No checks configured; these were detected from the project. Pass `checks` to override.',
        '',
        '| Component | Check | Fix if failing |',
        '|-----------|-------|----------------|',
      ];
      for (const c of detected) {
        detectedLines.push(`| ${c.name} | \`${c.check}\` | \`${c.fix}\` |`);
      }
      detectedLines.push(
        '',
        'Run the checks via `run_command`, then `validate_advance` when ready for L2.',
      );
      return success(detectedLines.join('\n'));
    },
  );
  state.registerTool('validate_prerequisites', 'validate', prerequisitesHandle);

  const setupHandle = server.registerTool(
    'validate_setup',
    {
      description:
        'Get a setup recipe by name. Recipes are loaded from .cortex/recipes/<name>.md in your project root if present, or returns guidance on creating one.',
      inputSchema: {
        target: z.string().describe('Recipe name (e.g. "local_ci", "dev_server", "e2e_tests")'),
      },
    },
    async (args) => {
      // Try to load from .cortex/recipes/ directory
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');

      const recipePaths = [
        join(process.cwd(), '.cortex', 'recipes', `${args.target}.md`),
        join(process.cwd(), '.cortex', 'recipes', `${args.target}.txt`),
      ];

      for (const path of recipePaths) {
        if (existsSync(path)) {
          const recipe = readFileSync(path, 'utf-8');
          const taskId = state.getActiveTaskId();
          if (taskId) {
            updateTask(taskId, { findings: `[validate:setup] target=${args.target}` }, 'validate');
          }
          return success(recipe);
        }
      }

      return success(
        [
          `## Setup Recipe: ${args.target}`,
          '',
          `No recipe found for "${args.target}".`,
          '',
          'To create one, add a markdown file at:',
          `  .cortex/recipes/${args.target}.md`,
          '',
          'The file should contain step-by-step setup instructions, commands, config paths, and known gotchas.',
          '',
          '### Example structure',
          '```markdown',
          '## Local Dev Server',
          '',
          '```bash',
          'npm run dev',
          '```',
          '',
          '**Port:** 3000',
          '**Config:** .env.local',
          '**Depends on:** PostgreSQL (docker-compose up -d postgres)',
          '```',
        ].join('\n'),
      );
    },
  );
  state.registerTool('validate_setup', 'validate', setupHandle);

  const advanceHandle = server.registerTool(
    'validate_advance',
    {
      description:
        'Advance to the next validate level. L1->L2 adds flow verification. L2->L3 adds browser automation.',
    },
    async () => {
      const result = state.advanceLevel();
      if (result.error) return success(result.error);

      const levelDescriptions: Record<number, string> = {
        2: 'Level 2: Flow verification enabled. Use `validate_integration_flow` to check pipeline stage health for an entity.',
        3: 'Level 3: Browser automation enabled. Playwright tools available for UI verification.',
      };

      return success(
        `Advanced to validate ${levelDescriptions[result.level!] || `level ${result.level}`}`,
      );
    },
  );
  state.registerTool('validate_advance', 'validate', advanceHandle);

  // -- Level 2: Integration flow verification --

  const integrationFlowHandle = server.registerTool(
    'validate_integration_flow',
    {
      description:
        "Verify an entity's end-to-end pipeline health. Define stages to check, or get a template to fill in.",
      inputSchema: {
        entity_id: z.string().describe('Primary entity identifier'),
        stages: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z
              .array(
                z.object({
                  name: z.string().describe('Stage name'),
                  check: z.string().describe('Shell command or query to verify this stage'),
                  expect: z.string().describe('What a healthy result looks like'),
                }),
              )
              .optional(),
          )
          .describe('Pipeline stages to check. If omitted, returns a template.'),
      },
    },
    async (args) => {
      const stages = args.stages as
        | Array<{ name: string; check: string; expect: string }>
        | undefined;

      if (stages && stages.length > 0) {
        const lines = [`## Integration Flow Verification: ${args.entity_id}`, ''];

        for (let i = 0; i < stages.length; i++) {
          const s = stages[i];
          lines.push(`### Stage ${i + 1}: ${s.name}`);
          lines.push('```bash');
          lines.push(s.check);
          lines.push('```');
          lines.push(`**Expect:** ${s.expect}`);
          lines.push('');
        }

        lines.push('### Health Verdict');
        lines.push('Run each stage via `run_command` and compare against expected results.');
        lines.push('All stages pass = HEALTHY. Any mismatch = investigate that stage.');

        const taskId = state.getActiveTaskId();
        if (taskId) {
          updateTask(
            taskId,
            {
              findings: `[validate:flow] ${args.entity_id} -- ${stages.length}-stage health check`,
            },
            'validate',
          );
        }

        return success(lines.join('\n'));
      }

      // No stages -- return template
      return success(
        [
          `## Integration Flow Verification: ${args.entity_id}`,
          '',
          'Define your pipeline stages. Example for an event-driven system:',
          '',
          '```json',
          '[',
          '  {',
          '    "name": "Ingestion check",',
          '    "check": "<query your DB for entity record>",',
          '    "expect": "Record exists with status processed"',
          '  },',
          '  {',
          '    "name": "Queue/outbox check",',
          '    "check": "<query outbox or message queue>",',
          '    "expect": "Messages with status sent, recent timestamps"',
          '  },',
          '  {',
          '    "name": "Downstream effect check",',
          '    "check": "<query downstream service DB>",',
          '    "expect": "Derived records exist with non-zero values"',
          '  }',
          ']',
          '```',
          '',
          'Pass this array as the `stages` parameter.',
          'Use your database tools (could be an external tool paired with cortex) to build the check commands.',
        ].join('\n'),
      );
    },
  );
  state.registerTool('validate_integration_flow', 'validate', integrationFlowHandle);
}
