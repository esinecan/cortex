import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import type { GeneratedPathwayStep, PathwayProof } from '../types.js';
import { getTask, updateTask } from '../tasks.js';
import { saveTask, loadTask } from '../storage.js';
import { resolveState, getStateNames } from '../states.js';

function success(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function error(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Pathway tools: generate, advance, prove, and status for runtime-generated pathways.
 * All registered as always-on since pathway management spans states.
 */
export function registerPathwayTools(server: McpServer, state: StateManager): void {

  const generateHandle = server.registerTool(
    'pathway_generate',
    {
      description: 'Generate a runtime pathway for a task. Decompose into steps, each pinned to a cortex state with acceptance criteria that gate advancement. Use cortex_discover to check which tools belong to which state before composing steps.',
      inputSchema: {
        task_id: z.string().describe('Task to attach the pathway to'),
        goal: z.string().describe('What the pathway aims to accomplish'),
        steps: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.object({
            label: z.string().describe('Human-readable step name'),
            base_state: z.string().describe('Cortex state for this step (recon, implement, debug, etc.)'),
            description: z.string().describe('What to do in this step'),
            acceptance_criteria: z.array(z.string()).describe('Checklist items that must be met'),
            tools: z.array(z.string()).default([]).describe('Cortex tools to enable (subset of base_state tools). Empty = use full state defaults.'),
            external_guidance: z.object({
              use: z.array(z.string()).default([]),
              avoid: z.array(z.string()).default([]),
            }).default({ use: [], avoid: [] }).describe('External tool guidance'),
            constraints: z.array(z.string()).default([]).describe('Constraints for this step'),
          })),
        ).describe('Ordered steps as JSON array'),
        strict: z.boolean().default(true).describe('Hard gate on advancement (default true)'),
      },
    },
    async (args) => {
      const task = getTask(args.task_id);
      if (!task) return error(`Task ${args.task_id} not found.`);
      if (task.status !== 'active') return error(`Task ${args.task_id} is ${task.status}, not active.`);
      if (task.generated_pathway) return error('Task already has a generated pathway. Complete or reset it first.');
      if (task.pathway) return error(`Task has static pathway "${task.pathway}". Clear it before generating a dynamic one.`);

      const steps = args.steps as Array<{
        label: string; base_state: string; description: string;
        acceptance_criteria: string[]; tools: string[];
        external_guidance: { use: string[]; avoid: string[] };
        constraints: string[];
      }>;

      if (steps.length === 0) return error('At least one step is required.');

      const validStates = new Set(getStateNames());
      const validatedSteps: GeneratedPathwayStep[] = [];

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];

        if (!validStates.has(s.base_state)) {
          return error(`Step ${i} ("${s.label}"): unknown base_state "${s.base_state}". Valid: ${[...validStates].join(', ')}`);
        }

        if (s.acceptance_criteria.length === 0) {
          return error(`Step ${i} ("${s.label}"): at least one acceptance criterion is required.`);
        }

        if (s.tools.length > 0 && s.base_state !== 'free') {
          const resolved = resolveState(s.base_state);
          if (resolved) {
            const stateTools = new Set(resolved.tools);
            const invalid = s.tools.filter(t => !stateTools.has(t));
            if (invalid.length > 0) {
              return error(`Step ${i} ("${s.label}"): tools not in ${s.base_state} state: ${invalid.join(', ')}`);
            }
          }
        }

        validatedSteps.push({
          id: `step-${i}`,
          label: s.label,
          base_state: s.base_state,
          description: s.description,
          acceptance_criteria: s.acceptance_criteria,
          criteria_met: [],
          tools: s.tools,
          external_guidance: s.external_guidance,
          constraints: s.constraints,
          proofs: [],
          status: i === 0 ? 'active' : 'pending',
        });
      }

      task.generated_pathway = {
        generated_at: new Date().toISOString(),
        goal: args.goal,
        steps: validatedSteps,
        current_step_index: 0,
        strict_enforcement: args.strict,
      };

      saveTask(task);

      updateTask(args.task_id, {
        findings: `[pathway:generated] ${args.goal} (${validatedSteps.length} steps, ${args.strict ? 'strict' : 'soft'} enforcement)`,
      }, state.getCurrentState());

      const lines = [
        `## Pathway Generated`,
        `**Goal:** ${args.goal}`,
        `**Steps:** ${validatedSteps.length}`,
        `**Enforcement:** ${args.strict ? 'strict (criteria required before advance)' : 'soft (warn on unmet criteria)'}`,
        '',
      ];
      for (let i = 0; i < validatedSteps.length; i++) {
        const s = validatedSteps[i];
        const marker = i === 0 ? '>> ' : '   ';
        lines.push(`${marker}${i}. **${s.label}** (${s.base_state}) - ${s.acceptance_criteria.length} criteria`);
      }

      const first = validatedSteps[0];
      lines.push('', `**Start:** \`enter_state("${first.base_state}", task_id="${args.task_id}")\``);

      return success(lines.join('\n'));
    },
  );
  state.registerTool('pathway_generate', 'always-on', generateHandle);

  const advanceHandle = server.registerTool(
    'pathway_advance',
    {
      description: 'Advance to the next step in the generated pathway. Hard-gated: all acceptance criteria must be met unless force=true.',
      inputSchema: {
        force: z.boolean().default(false).describe('Bypass criteria gate (requires reason)'),
        reason: z.string().optional().describe('Why you are forcing advancement (required if force=true)'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      if (!taskId) return error('No active task.');

      const task = loadTask(taskId);
      if (!task?.generated_pathway) return error('Active task has no generated pathway.');

      const gp = task.generated_pathway;
      const currentStep = gp.steps[gp.current_step_index];
      if (!currentStep || currentStep.status !== 'active') {
        return error('No active step to advance from.');
      }

      const unmetIndices = currentStep.acceptance_criteria
        .map((_, i) => i)
        .filter(i => !currentStep.criteria_met.includes(i));

      if (unmetIndices.length > 0 && gp.strict_enforcement && !args.force) {
        const unmetList = unmetIndices
          .map(i => `  ${i}. ${currentStep.acceptance_criteria[i]}`)
          .join('\n');
        return error(
          `Cannot advance. ${unmetIndices.length} unmet criteria:\n${unmetList}\n\n` +
          'Use `pathway_advance(force=true, reason="...")` to bypass, or `pathway_prove` to satisfy criteria.'
        );
      }

      if (args.force && unmetIndices.length > 0) {
        if (!args.reason) return error('force=true requires a reason.');
        updateTask(taskId, {
          findings: `[pathway:forced-advance] Skipped ${unmetIndices.length} criteria on "${currentStep.label}". Reason: ${args.reason}`,
        }, state.getCurrentState());
      }

      currentStep.status = 'completed';

      const nextIndex = gp.current_step_index + 1;

      if (nextIndex >= gp.steps.length) {
        gp.current_step_index = nextIndex;
        saveTask(task);

        updateTask(taskId, {
          findings: `[pathway:complete] All ${gp.steps.length} steps done.`,
        }, state.getCurrentState());

        return success('## Pathway Complete\n\nAll steps finished. Use `task_update(status="completed")` to close the task.');
      }

      gp.current_step_index = nextIndex;
      const nextStep = gp.steps[nextIndex];
      nextStep.status = 'active';
      saveTask(task);

      state.enterState(nextStep.base_state, taskId);

      const lines = [
        `## Advanced to Step ${nextIndex}: ${nextStep.label}`,
        `**State:** ${nextStep.base_state}`,
        `**Description:** ${nextStep.description}`,
        '',
        '### Acceptance Criteria',
      ];
      for (let i = 0; i < nextStep.acceptance_criteria.length; i++) {
        lines.push(`- [ ] ${nextStep.acceptance_criteria[i]}`);
      }
      if (nextStep.tools.length > 0) {
        lines.push('', '### Declared Tools');
        lines.push(nextStep.tools.map(t => `- \`${t}\``).join('\n'));
      }
      if (nextStep.constraints.length > 0) {
        lines.push('', '### Constraints');
        for (const c of nextStep.constraints) lines.push(`- ${c}`);
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('pathway_advance', 'always-on', advanceHandle);

  const proveHandle = server.registerTool(
    'pathway_prove',
    {
      description: 'Submit evidence for the current step. Mark acceptance criteria as met and attach proof.',
      inputSchema: {
        criteria_indices: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.number().int().min(0)),
        ).describe('Which acceptance criteria are now met (indices)'),
        proof_type: z.enum(['test_output', 'screenshot', 'log_evidence', 'manual_verification', 'audit_result'])
          .describe('Type of evidence'),
        description: z.string().describe('Evidence text'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      if (!taskId) return error('No active task.');

      const task = loadTask(taskId);
      if (!task?.generated_pathway) return error('Active task has no generated pathway.');

      const gp = task.generated_pathway;
      const step = gp.steps[gp.current_step_index];
      if (!step || step.status !== 'active') return error('No active step.');

      const indices = args.criteria_indices as number[];

      const outOfBounds = indices.filter(i => i < 0 || i >= step.acceptance_criteria.length);
      if (outOfBounds.length > 0) {
        return error(`Invalid criteria indices: ${outOfBounds.join(', ')}. Valid range: 0-${step.acceptance_criteria.length - 1}`);
      }

      const metSet = new Set(step.criteria_met);
      for (const i of indices) metSet.add(i);
      step.criteria_met = [...metSet].sort((a, b) => a - b);

      const proof: PathwayProof = {
        type: args.proof_type,
        description: args.description,
        timestamp: new Date().toISOString(),
      };
      step.proofs.push(proof);

      saveTask(task);

      const remaining = step.acceptance_criteria.length - step.criteria_met.length;
      const lines = [
        `## Proof Recorded`,
        `**Type:** ${args.proof_type}`,
        `**Criteria satisfied:** ${indices.map(i => `${i} ("${step.acceptance_criteria[i]}")`).join(', ')}`,
        '',
      ];

      if (remaining === 0) {
        lines.push('**All criteria met.** Ready to `pathway_advance`.');
      } else {
        lines.push(`**Remaining:** ${remaining} criteria`);
        const unmet = step.acceptance_criteria
          .map((c, i) => ({ c, i }))
          .filter(({ i }) => !step.criteria_met.includes(i));
        for (const { c, i } of unmet) {
          lines.push(`- [ ] ${i}: ${c}`);
        }
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('pathway_prove', 'always-on', proveHandle);

  const statusHandle = server.registerTool(
    'pathway_status',
    {
      description: 'Show full progress of the generated pathway: all steps, criteria, proofs.',
    },
    async () => {
      const taskId = state.getActiveTaskId();
      if (!taskId) return error('No active task.');

      const task = loadTask(taskId);
      if (!task?.generated_pathway) return error('Active task has no generated pathway.');

      const gp = task.generated_pathway;
      const completed = gp.steps.filter(s => s.status === 'completed').length;
      const pct = Math.round((completed / gp.steps.length) * 100);

      const lines = [
        `## Pathway: ${gp.goal}`,
        `**Progress:** ${completed}/${gp.steps.length} steps (${pct}%)`,
        `**Enforcement:** ${gp.strict_enforcement ? 'strict' : 'soft'}`,
        '',
      ];

      for (let i = 0; i < gp.steps.length; i++) {
        const step = gp.steps[i];
        const isCurrent = i === gp.current_step_index && step.status === 'active';
        const marker = isCurrent ? '>> ' : '   ';
        const statusLabel = step.status === 'completed' ? 'DONE'
          : step.status === 'active' ? 'ACTIVE'
          : step.status === 'skipped' ? 'SKIPPED'
          : 'PENDING';

        lines.push(`${marker}**Step ${i}: ${step.label}** [${statusLabel}] (${step.base_state})`);

        if (step.status === 'active' || step.status === 'completed') {
          const met = step.criteria_met.length;
          const total = step.acceptance_criteria.length;
          lines.push(`${marker}  Criteria: ${met}/${total}`);

          for (let j = 0; j < step.acceptance_criteria.length; j++) {
            const check = step.criteria_met.includes(j) ? 'x' : ' ';
            lines.push(`${marker}  - [${check}] ${step.acceptance_criteria[j]}`);
          }

          if (step.proofs.length > 0) {
            for (const p of step.proofs) {
              lines.push(`${marker}  proof: [${p.type}] ${p.description}`);
            }
          }
        }

        lines.push('');
      }

      return success(lines.join('\n'));
    },
  );
  state.registerTool('pathway_status', 'always-on', statusHandle);
}
