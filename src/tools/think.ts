/**
 * Vendored, slimmed-down adaptation of the official sequential-thinking MCP
 * server (modelcontextprotocol/servers/src/sequentialthinking) -- folded into
 * cortex as a single always-on `think` tool.
 *
 * Purpose: a structured scratchpad for multi-step reasoning. Each call records
 * one thought; the tool returns running totals (history length, branches,
 * whether more thoughts are expected). Matches the upstream contract -- thought
 * numbering, revisions, and branches -- but drops the chalk dependency, picks
 * a shorter tool name, and surfaces the cortex active task in the response so
 * thinking sessions can be correlated to ongoing work.
 *
 * State: always-on. Reasoning is universally useful and orthogonal to the
 * cortex state machine -- it shouldn't be hidden by gating.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';

interface Thought {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
}

/**
 * Per-process thought log. Lives only in memory; cortex tasks remain the
 * authoritative cross-session record via findings. Branches are tracked by id
 * so the model can fork and revisit alternative lines of reasoning.
 */
class ThinkSession {
  private readonly history: Thought[] = [];
  private readonly branches: Record<string, Thought[]> = {};
  private readonly silent =
    (process.env.CORTEX_THINK_SILENT || process.env.DISABLE_THOUGHT_LOGGING || '').toLowerCase() ===
    'true';

  record(input: Thought): {
    thoughtNumber: number;
    totalThoughts: number;
    nextThoughtNeeded: boolean;
    branches: string[];
    thoughtHistoryLength: number;
  } {
    // Auto-stretch totalThoughts if the model overshoots its initial estimate.
    if (input.thoughtNumber > input.totalThoughts) {
      input.totalThoughts = input.thoughtNumber;
    }

    this.history.push(input);

    if (input.branchFromThought && input.branchId) {
      (this.branches[input.branchId] ??= []).push(input);
    }

    if (!this.silent) {
      process.stderr.write(format(input) + '\n');
    }

    return {
      thoughtNumber: input.thoughtNumber,
      totalThoughts: input.totalThoughts,
      nextThoughtNeeded: input.nextThoughtNeeded,
      branches: Object.keys(this.branches),
      thoughtHistoryLength: this.history.length,
    };
  }
}

/** Render a thought to a plain-text box for stderr (no chalk dependency). */
function format(t: Thought): string {
  let header: string;
  if (t.isRevision) {
    header = `Revision ${t.thoughtNumber}/${t.totalThoughts} (revising thought ${t.revisesThought ?? '?'})`;
  } else if (t.branchFromThought) {
    header = `Branch ${t.thoughtNumber}/${t.totalThoughts} (from thought ${t.branchFromThought}, id=${t.branchId ?? '?'})`;
  } else {
    header = `Thought ${t.thoughtNumber}/${t.totalThoughts}`;
  }
  const width = Math.max(header.length, t.thought.length) + 4;
  const border = '─'.repeat(width - 2);
  return `\n┌${border}┐\n│ ${header.padEnd(width - 4)} │\n├${border}┤\n│ ${t.thought.padEnd(width - 4)} │\n└${border}┘`;
}

/** Coerce "true" / "false" strings to booleans (some clients send strings). */
const coercedBoolean = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return val;
}, z.boolean());

const THINK_DESCRIPTION = `Structured scratchpad for multi-step reasoning. Record one thought per call; the tool returns running totals so you can see where you are in your reasoning chain.

Use it when:
- You're about to take a multi-step action and want to plan first.
- You're stuck and need to enumerate hypotheses or disconfirm one.
- You want to check your assumptions before committing to an interpretation.
- You're branching between alternative approaches and want to come back later.

Each thought can:
- Build linearly on prior thoughts.
- Revise an earlier thought (set isRevision + revisesThought).
- Branch from a prior thought (set branchFromThought + branchId).
- Express uncertainty -- expected and useful.

You can adjust totalThoughts up or down as your understanding evolves; the tool will stretch the total if you overshoot. Set nextThoughtNeeded=false only when you have an answer you would actually act on.

The response includes the cortex active task id when one is set, so a thinking session is anchored to ongoing work.`;

export function registerThinkTools(server: McpServer, state: StateManager): void {
  const session = new ThinkSession();

  const handle = server.registerTool(
    'think',
    {
      title: 'Structured thinking',
      description: THINK_DESCRIPTION,
      inputSchema: {
        thought: z.string().describe('The current thinking step.'),
        nextThoughtNeeded: coercedBoolean.describe(
          'True if you need another thought after this one. Set false only when you have an answer.',
        ),
        thoughtNumber: z.coerce
          .number()
          .int()
          .min(1)
          .describe('1-based index of this thought in the chain.'),
        totalThoughts: z.coerce
          .number()
          .int()
          .min(1)
          .describe('Current estimate of how many thoughts you will need. Adjustable.'),
        isRevision: coercedBoolean.optional().describe('True if this revises an earlier thought.'),
        revisesThought: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .describe('When isRevision=true, which earlier thought number is being revised.'),
        branchFromThought: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .describe('When branching, the thought number this branch starts from.'),
        branchId: z.string().optional().describe('Identifier for the branch you are exploring.'),
        needsMoreThoughts: coercedBoolean
          .optional()
          .describe('True if you reached the planned end but realize more thinking is needed.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: {
        thoughtNumber: z.number(),
        totalThoughts: z.number(),
        nextThoughtNeeded: z.boolean(),
        branches: z.array(z.string()),
        thoughtHistoryLength: z.number(),
        activeTaskId: z.string().nullable(),
      },
    },
    async (args) => {
      const summary = session.record(args as Thought);
      const result = { ...summary, activeTaskId: state.getActiveTaskId() };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
  state.registerTool('think', 'always-on', handle);
}
