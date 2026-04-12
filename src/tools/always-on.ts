import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { createTask, updateTask, getTask, getTaskContext, listAllTasks } from '../tasks.js';
import { resolveState, formatStateInfo, getStateNames } from '../states.js';
import { getPathway, getPathwayNames, formatGuidance } from '../pathways.js';
import { loadFreeExploreLog } from '../storage.js';
import { getAllProxiedServers } from '../proxy.js';
import { success, error, respond } from '../respond.js';

/**
 * Always-on tools: task CRUD, state transitions, free explore, and tool discovery.
 * These are available in every state and never get disabled.
 */
export function registerAlwaysOnTools(server: McpServer, state: StateManager): void {
  const pathwayNames = getPathwayNames();
  const taskCreateHandle = server.registerTool(
    'task_create',
    {
      description: `Create a persistent task that survives across sessions. Max 3 active root tasks. Optionally assign a static pathway or use generate_pathway=true for a dynamic LLM-generated pathway. Pathways: ${pathwayNames.join(', ')}`,
      inputSchema: {
        title: z.string().describe('Brief task title'),
        description: z.string().optional().describe('What needs to be done'),
        parent_task_id: z.string().optional().describe('Parent task ID for subtasks'),
        pathway: z
          .string()
          .optional()
          .describe(`Workflow pathway: ${pathwayNames.join(', ')}`),
        generate_pathway: z
          .boolean()
          .optional()
          .describe('Set true to use a dynamic LLM-generated pathway instead of a static one'),
      },
    },
    async (args) => {
      if (args.pathway && args.generate_pathway) {
        return error('Cannot use both "pathway" and "generate_pathway". Choose one.');
      }

      if (args.pathway && !getPathway(args.pathway)) {
        return error(`Unknown pathway "${args.pathway}". Available: ${pathwayNames.join(', ')}`);
      }

      const result = createTask(
        args.title,
        args.description || '',
        args.parent_task_id || null,
        args.pathway || null,
      );
      if (result.error) return error(result.error);

      const task = result.task!;
      const lines = [`Task created: **${task.id}** -- ${task.title}`];

      if (task.pathway) {
        const pw = getPathway(task.pathway)!;
        lines.push(`\n**Pathway:** ${task.pathway} -- ${pw.description}`);
        lines.push(
          `**Initial state:** \`enter_state("${pw.initial_state}", task_id="${task.id}")\``,
        );
      } else if (args.generate_pathway) {
        lines.push('\n**Dynamic pathway mode.** Decompose this task into steps:');
        lines.push('`pathway_generate(task_id="' + task.id + '", goal="...", steps=[...])`');
        lines.push('');
        lines.push(
          'Each step declares: `label`, `base_state`, `description`, `acceptance_criteria`, `tools` (optional), `constraints` (optional).',
        );
        lines.push('');
        lines.push('**Workflow:**');
        lines.push('1. `pathway_generate(task_id, goal, steps=[...])` -- define the step sequence');
        lines.push("2. `enter_state` into the first step's `base_state`");
        lines.push(
          '3. Work the step. Use `pathway_prove(criteria_indices, proof_type, description)` to satisfy criteria.',
        );
        lines.push('4. `pathway_advance` to move forward (gated on criteria unless `force=true`).');
        lines.push('5. `pathway_status` to see full progress at any time.');
        lines.push('');
        lines.push(
          'Generated pathways enforce per-step tool scoping and require empirical proof before advancement.',
        );
        lines.push(
          'Use `cortex_discover` to see which tools belong to which state before composing steps.',
        );
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('task_create', 'always-on', taskCreateHandle);

  const taskUpdateHandle = server.registerTool(
    'task_update',
    {
      description: 'Update a persistent task: change status, append findings or notes.',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        status: z
          .enum(['active', 'paused', 'blocked', 'completed', 'abandoned'])
          .optional()
          .describe('New status'),
        findings: z.string().optional().describe('Finding to append (timestamped)'),
        notes: z.string().optional().describe('Note to append (timestamped)'),
        title: z.string().optional().describe('New title'),
      },
    },
    async (args) => {
      const result = updateTask(
        args.task_id,
        {
          status: args.status,
          findings: args.findings,
          notes: args.notes,
          title: args.title,
        },
        state.getCurrentState(),
      );
      if (result.error) return error(result.error);
      const t = result.task!;
      return respond(
        state,
        `Task ${t.id} updated. Status: ${t.status}. Findings: ${t.findings.length}.`,
        'Continue working, or `current_state` for guidance.',
      );
    },
  );
  state.registerTool('task_update', 'always-on', taskUpdateHandle);

  const taskListHandle = server.registerTool(
    'task_list',
    {
      description: 'List all persistent tasks with status and latest findings.',
    },
    async () => {
      return respond(
        state,
        listAllTasks(),
        'Resume a task with `task_context(id)`, or `task_create` to start new work.',
      );
    },
  );
  state.registerTool('task_list', 'always-on', taskListHandle);

  const taskGetHandle = server.registerTool(
    'task_get',
    {
      description:
        'Get raw JSON detail on a persistent task. Prefer `task_context` for formatted, LLM-friendly output.',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
      },
    },
    async (args) => {
      const task = getTask(args.task_id);
      if (!task) return error(`Task ${args.task_id} not found.`);
      return success(JSON.stringify(task, null, 2));
    },
  );
  state.registerTool('task_get', 'always-on', taskGetHandle);

  const taskContextHandle = server.registerTool(
    'task_context',
    {
      description:
        'Reconstruct context for a task as formatted markdown. This is the primary way to resume a task from a previous session. Prefer this over task_get. Paginated (50 findings/page).',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        page: z
          .preprocess(
            (val) => (typeof val === 'string' ? Number(val) : val),
            z.number().int().min(1).optional(),
          )
          .describe('Page number (default: 1)'),
        order: z
          .enum(['newest', 'oldest'])
          .optional()
          .describe(
            'newest = most recent findings on page 1 (default). oldest = chronological from start.',
          ),
      },
    },
    async (args) => {
      const ctx = getTaskContext(args.task_id, args.page ?? 1, args.order ?? 'newest');
      if (!ctx) return error(`Task ${args.task_id} not found.`);
      return success(ctx);
    },
  );
  state.registerTool('task_context', 'always-on', taskContextHandle);

  // -- State tools --

  const currentStateHandle = server.registerTool(
    'current_state',
    {
      description:
        'Show current state, available tools, constraints, active task, and pathway guidance.',
    },
    async () => {
      const s = state.getState();
      const resolved = resolveState(s.current_state, s.current_level ?? undefined);
      if (!resolved) {
        return success(`Current state: ${s.current_state} (free explore)`);
      }
      const info = formatStateInfo(resolved);
      const taskLine = s.active_task ? `\n**Active task:** ${s.active_task}` : '';

      let guidanceLine = '';
      if (s.active_task) {
        const task = getTask(s.active_task);
        if (task?.generated_pathway) {
          const gp = task.generated_pathway;
          const step = gp.steps[gp.current_step_index];
          if (step && step.status === 'active') {
            const met = step.criteria_met.length;
            const total = step.acceptance_criteria.length;
            const lines = [
              `## Generated Pathway: ${gp.goal}`,
              `### Current Step ${gp.current_step_index}: ${step.label}`,
              step.description,
              '',
              `**Criteria:** ${met}/${total}`,
            ];
            for (let i = 0; i < step.acceptance_criteria.length; i++) {
              const check = step.criteria_met.includes(i) ? 'x' : ' ';
              lines.push(`- [${check}] ${step.acceptance_criteria[i]}`);
            }
            if (step.constraints.length > 0) {
              lines.push('', '**Step Constraints:**');
              for (const c of step.constraints) lines.push(`- ${c}`);
            }
            const nextIndex = gp.current_step_index + 1;
            if (nextIndex < gp.steps.length) {
              lines.push('', `**Next:** Step ${nextIndex}: ${gp.steps[nextIndex].label}`);
            }
            guidanceLine = '\n\n' + lines.join('\n');
          }
        } else if (task?.pathway) {
          guidanceLine =
            '\n\n' + formatGuidance(task.pathway, s.current_state, s.current_level ?? undefined);
        }
      }

      return success(info + taskLine + guidanceLine);
    },
  );
  state.registerTool('current_state', 'always-on', currentStateHandle);

  const enterStateHandle = server.registerTool(
    'enter_state',
    {
      description:
        'Transition to a workflow state. Tools for that state become available; other state tools disappear.',
      inputSchema: {
        state: z
          .enum([
            'base',
            'recon',
            'plan',
            'implement',
            'debug',
            'validate',
            'review',
            'browse',
            'free',
          ])
          .describe('Target state'),
        task_id: z.string().optional().describe('Associate with a persistent task'),
        level: z
          .preprocess(
            (val) => (typeof val === 'string' ? Number(val) : val),
            z.number().int().min(1).max(3).optional(),
          )
          .describe('Starting level for leveled states like validate (default: 1)'),
      },
    },
    async (args) => {
      const err = state.enterState(args.state, args.task_id, args.level as number | undefined);
      if (err) return error(err);
      const s = state.getState();
      const resolved = resolveState(s.current_state, s.current_level ?? undefined);
      if (!resolved) return error('Failed to resolve state.');

      let guidanceLine = '';
      if (s.active_task) {
        const task = getTask(s.active_task);
        if (task?.generated_pathway) {
          const gp = task.generated_pathway;
          const step = gp.steps[gp.current_step_index];
          if (step && step.status === 'active') {
            const lines = [
              `## Pathway Step ${gp.current_step_index}: ${step.label}`,
              step.description,
              '',
              '### Acceptance Criteria',
            ];
            for (let i = 0; i < step.acceptance_criteria.length; i++) {
              const check = step.criteria_met.includes(i) ? 'x' : ' ';
              lines.push(`- [${check}] ${step.acceptance_criteria[i]}`);
            }
            if (step.tools.length > 0) {
              lines.push('', '### Declared Tools');
              lines.push(step.tools.map((t) => `- \`${t}\``).join('\n'));
            }
            if (step.constraints.length > 0) {
              lines.push('', '### Constraints');
              for (const c of step.constraints) lines.push(`- ${c}`);
            }
            guidanceLine = '\n\n' + lines.join('\n');
            guidanceLine +=
              '\n\n*Generated pathways gate advancement on criteria. Use `pathway_prove` to satisfy criteria, `pathway_advance` to move forward.*';
          }
        } else if (task?.pathway) {
          guidanceLine =
            '\n\n' + formatGuidance(task.pathway, s.current_state, s.current_level ?? undefined);
          guidanceLine +=
            '\n\n*Static pathways suggest, never enforce. Checkpoint progress regularly -- findings persist across sessions.*';
        }
      }

      return success(formatStateInfo(resolved) + guidanceLine);
    },
  );
  state.registerTool('enter_state', 'always-on', enterStateHandle);

  const freeExploreHandle = server.registerTool(
    'free_explore',
    {
      description:
        'Ad-hoc escape hatch from any state. Temporarily unlocks all tools. Call `exit_free` to return to your previous state.',
      inputSchema: {
        reason: z.string().optional().describe('Why are you escaping the current state?'),
      },
    },
    async (args) => {
      state.enterFreeExplore(args.reason);
      return success(
        '## Free Explore\n\nAll tools enabled. No constraints.\n\n' +
          'Call `exit_free` to return to your previous state.\n' +
          (args.reason ? `\n**Reason:** ${args.reason}` : ''),
      );
    },
  );
  state.registerTool('free_explore', 'always-on', freeExploreHandle);

  const exitFreeHandle = server.registerTool(
    'exit_free',
    {
      description: 'Exit free exploration and return to the previous state.',
    },
    async () => {
      const returnState = state.exitFreeExplore();
      return respond(
        state,
        `Returned to **${returnState}** state.`,
        '`current_state` for available tools and guidance.',
      );
    },
  );
  state.registerTool('exit_free', 'always-on', exitFreeHandle);

  const discoverHandle = server.registerTool(
    'cortex_discover',
    {
      description:
        'Search all cortex tools across all states. In free explore, use this to find and enable specific tools.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Search query -- matches tool names and state assignments'),
        enable: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()).optional(),
          )
          .describe('Tool names to enable (free explore only)'),
        disable: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()).optional(),
          )
          .describe('Tool names to disable after use (free explore only)'),
      },
    },
    async (args) => {
      const allTools = state.listAllTools();
      const lines: string[] = [];

      if (args.enable && (args.enable as string[]).length > 0) {
        const result = state.enableTools(args.enable as string[]);
        if (result.enabled > 0) lines.push(`Enabled ${result.enabled} tool(s).`);
        if (result.notFound.length > 0) lines.push(`Not found: ${result.notFound.join(', ')}`);
        lines.push('');
      }

      if (args.disable && (args.disable as string[]).length > 0) {
        const count = state.disableTools(args.disable as string[]);
        if (count > 0) lines.push(`Disabled ${count} tool(s).`);
        lines.push('');
      }

      const query = args.query?.toLowerCase();
      const filtered = query
        ? allTools.filter(
            (t) => t.name.toLowerCase().includes(query) || t.state.toLowerCase().includes(query),
          )
        : allTools;

      const byState = new Map<string, typeof filtered>();
      for (const t of filtered) {
        const group = byState.get(t.state) || [];
        group.push(t);
        byState.set(t.state, group);
      }

      lines.push(`## Tools${query ? ` matching "${query}"` : ''} (${filtered.length} total)`);
      lines.push('');

      for (const [stateName, tools] of byState) {
        lines.push(`### ${stateName}`);
        for (const t of tools) {
          const marker = t.enabled ? '**ON**' : 'off';
          lines.push(`- \`${t.name}\` [${marker}]`);
        }
        lines.push('');
      }

      if (state.getCurrentState() === 'free') {
        lines.push(
          '*Use `enable: ["tool_name"]` to activate tools, `disable: ["tool_name"]` to release them.*',
        );
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('cortex_discover', 'always-on', discoverHandle);

  const exitStateHandle = server.registerTool(
    'exit_state',
    {
      description: 'Return to base state.',
    },
    async () => {
      state.exitState();
      return respond(
        state,
        'Returned to **base** state.',
        '`task_list` to see active tasks, `enter_state` to begin work, or `suggest_state` to find the right state.',
      );
    },
  );
  state.registerTool('exit_state', 'always-on', exitStateHandle);

  const suggestStateHandle = server.registerTool(
    'suggest_state',
    {
      description: 'Describe what you want to do and get a state recommendation.',
      inputSchema: {
        intent: z.string().describe('What are you trying to accomplish?'),
      },
    },
    async (args) => {
      const intent = args.intent.toLowerCase();
      const states = getStateNames().filter((s) => s !== 'free');
      const scores: { state: string; score: number; description: string }[] = [];

      const keywords: Record<string, string[]> = {
        recon: [
          'understand',
          'read',
          'explore',
          'investigate',
          'learn',
          'ticket',
          'context',
          'what is',
          'how does',
        ],
        plan: ['plan', 'design', 'architect', 'approach', 'strategy', 'rfc', 'proposal'],
        implement: [
          'code',
          'build',
          'implement',
          'write',
          'create',
          'add',
          'fix',
          'change',
          'modify',
          'refactor',
        ],
        debug: [
          'debug',
          'error',
          'bug',
          'broken',
          'failing',
          'trace',
          'log',
          'issue',
          'not working',
          '500',
          '404',
        ],
        validate: [
          'test',
          'verify',
          'validate',
          'e2e',
          'prerequisite',
          'local ci',
          'flow check',
          'sanity',
        ],
        review: ['review', 'pr', 'pull request', 'check', 'commit', 'diff'],
        browse: ['browse', 'web', 'url', 'page', 'screenshot', 'playwright'],
      };

      for (const stateName of states) {
        const stateKeywords = keywords[stateName] || [];
        const resolved = resolveState(stateName);
        if (!resolved) continue;

        let score = 0;
        for (const kw of stateKeywords) {
          if (intent.includes(kw)) score += 1;
        }
        scores.push({ state: stateName, score, description: resolved.description });
      }

      scores.sort((a, b) => b.score - a.score);
      const best = scores[0];

      const lines = [state.breadcrumb(), '', '## State Reference', ''];

      // Always show all states so the LLM can make an informed choice
      for (const s of scores) {
        const isBest = s === best && s.score > 0;
        const prefix = isBest ? '>> ' : '   ';
        const marker = s.score > 0 ? ` (${s.score} matches)` : '';
        lines.push(`${prefix}- **${s.state}**${marker}: ${s.description}`);
      }

      if (best.score > 0) {
        lines.push('', `**Suggested:** \`enter_state("${best.state}")\``);
      } else {
        lines.push('');
        lines.push(
          'No strong match. Pick the best fit above, or use `free_explore` as an escape hatch.',
        );
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('suggest_state', 'always-on', suggestStateHandle);

  const doctorHandle = server.registerTool(
    'cortex_doctor',
    {
      description:
        'Health check. Tests proxied MCP server connections, reports tool counts, and flags tool names referenced in states.yaml that are not registered in any server.',
    },
    async () => {
      const lines: string[] = ['# Cortex Health Check', ''];

      const servers = getAllProxiedServers();
      lines.push('## Proxied Servers', '');
      if (servers.size === 0) {
        lines.push('No servers connected.');
      } else {
        for (const [name, srv] of servers) {
          lines.push(`- **${name}**: ${srv.toolNames.length} tools registered`);
        }
      }

      const stateNames = getStateNames();
      const referencedTools = new Set<string>();
      for (const sn of stateNames) {
        for (const level of [undefined, 1, 2, 3]) {
          const resolved = resolveState(sn, level);
          if (resolved) {
            for (const t of resolved.tools) referencedTools.add(t);
          }
        }
      }

      const allRegistered = new Set(state.listAllTools().map((t) => t.name));

      const orphaned = [...referencedTools].filter((t) => !allRegistered.has(t));

      lines.push('', '## Tool Registry', '');
      lines.push(`- **Registered:** ${allRegistered.size} tools`);
      lines.push(`- **Referenced in states.yaml:** ${referencedTools.size} tool names`);

      if (orphaned.length > 0) {
        lines.push('', '## Orphaned References', '');
        lines.push('Tools listed in states.yaml but not registered (silent no-ops):');
        for (const t of orphaned.sort()) {
          lines.push(`- \`${t}\``);
        }
      } else {
        lines.push('', 'All states.yaml tool references resolve to registered tools.');
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('cortex_doctor', 'always-on', doctorHandle);

  const freeExploreAnalysisHandle = server.registerTool(
    'free_explore_analysis',
    {
      description:
        'Analyze the free explore audit log. Identifies recurring state escape patterns and suggests pathway additions.',
    },
    async () => {
      const entries = loadFreeExploreLog();
      if (entries.length === 0) {
        return success(
          'No free explore entries recorded yet. Use `free_explore` during work to generate data.',
        );
      }

      const byFromState = new Map<
        string,
        { count: number; reasons: string[]; totalDuration: number; entries: number }
      >();

      for (const entry of entries) {
        if (entry.duration_seconds !== null && entry.duration_seconds < 0) continue;

        const existing = byFromState.get(entry.from_state) || {
          count: 0,
          reasons: [],
          totalDuration: 0,
          entries: 0,
        };
        existing.count++;
        if (entry.reason && !existing.reasons.includes(entry.reason)) {
          existing.reasons.push(entry.reason);
        }
        if (entry.duration_seconds !== null && entry.duration_seconds > 0) {
          existing.totalDuration += entry.duration_seconds;
          existing.entries++;
        }
        byFromState.set(entry.from_state, existing);
      }

      const sorted = [...byFromState.entries()].sort((a, b) => b[1].count - a[1].count);
      const recurring = sorted.filter(([, v]) => v.count >= 3);

      const lines: string[] = [
        '# Free Explore Analysis',
        '',
        `**Total escapes:** ${entries.length}`,
        '',
        '## Escape Frequency by State',
        '',
      ];

      for (const [fromState, data] of sorted) {
        const avgDuration = data.entries > 0 ? Math.round(data.totalDuration / data.entries) : null;
        const durationStr = avgDuration !== null ? ` | avg ${avgDuration}s` : '';
        lines.push(`- **${fromState}**: ${data.count} escapes${durationStr}`);
        if (data.reasons.length > 0) {
          for (const r of data.reasons.slice(0, 5)) {
            lines.push(`  - "${r}"`);
          }
        }
      }

      if (recurring.length > 0) {
        lines.push('', '## Recurring Patterns (3+ escapes)', '');
        lines.push(
          'These states are escaped frequently -- consider adding tools or pathway steps.',
        );
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('free_explore_analysis', 'always-on', freeExploreAnalysisHandle);
}
