import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { loadTask } from '../storage.js';
import { success } from '../respond.js';

/**
 * Coach tools: an active-recall coaching loop with durable findings.
 *
 * Design constraints:
 *   - Single-call entry. `coach_resume` returns top-3 open revisits plus the
 *     most recent parked thread, so the session opens with a thin pick list,
 *     not an open-ended prompt.
 *   - Working state lives in task findings, never in head. Quiz rounds, gaps,
 *     queued revisits, and parked threads are all persisted as findings so
 *     the loop survives session death.
 *   - Cap-3 on resume. Older revisits stay in the audit trail but never
 *     become a long backlog the user has to triage on re-entry.
 *   - Question-style rotation is recorded per round so the next round can
 *     vary deliberately instead of grinding the same stem.
 *   - No gamification. Bloom level + assessment is the only signal kept.
 *
 * All findings are written with prefixed tags ([coach:revisit], [coach:gap],
 * etc.) so `coach_resume` can filter cheaply and an external dashboard can
 * render a coach view without a schema migration.
 */
export function registerCoachTools(server: McpServer, state: StateManager): void {
  // -- coach_resume ----------------------------------------------------
  // Single-call entry point. Returns top-3 open revisits + most recent
  // parked thread. If nothing prior, returns a soft cold-start prompt.

  const resumeHandle = server.registerTool(
    'coach_resume',
    {
      description:
        'Open the next coaching session. Surfaces top-3 open revisits (hard cap, no backlog cliff) plus the most recent parked thread. Reply with 1, 2, 3, parked, or a free-text concept. Use this as the FIRST move in the coach state.',
      inputSchema: {},
    },
    async () => {
      const taskId = state.getActiveTaskId();
      if (!taskId) {
        return success(
          [
            '## Coach: cold start',
            '',
            'No active task -- coaching findings will not persist.',
            '',
            '**Options:**',
            '1) `task_create(title="Coaching: <topic>", description="...")` to anchor the session',
            '2) Proceed without persistence (single-shot only)',
            '',
            'After choosing, call `coach_resume` again or jump to `coach_quiz`.',
          ].join('\n'),
        );
      }

      const task = loadTask(taskId);
      if (!task) {
        return success(`Task ${taskId} not found. Re-create or switch active task.`);
      }

      const revisits = task.findings
        .filter((f) => f.content.startsWith('[coach:revisit]'))
        .slice()
        .reverse()
        .slice(0, 3);
      const threads = task.findings
        .filter((f) => f.content.startsWith('[coach:thread]'))
        .slice()
        .reverse()
        .slice(0, 1);
      const lastQuiz = task.findings
        .filter((f) => f.content.startsWith('[coach:quiz]'))
        .slice(-1)[0];

      const lines: string[] = ['## Coach: pick one', ''];

      if (revisits.length > 0) {
        lines.push('**Top revisits (cap 3):**');
        revisits.forEach((f, i) => {
          const days = daysSince(f.ts);
          lines.push(`${i + 1}) ${stripTag(f.content)} _(saved ${days}d ago)_`);
        });
        lines.push('');
      }

      if (threads.length > 0) {
        lines.push('**Parked thread:**');
        lines.push(
          `parked) ${stripTag(threads[0].content)} _(${daysSince(threads[0].ts)}d ago)_`,
        );
        lines.push('');
      }

      if (revisits.length === 0 && threads.length === 0) {
        lines.push('**No prior weak areas on this task.**');
        lines.push(
          'Pick a concept tied to the task or recent work. Cheaper than open-ended.',
        );
        lines.push('');
      }

      if (lastQuiz) {
        lines.push(
          `_Last quiz: ${daysSince(lastQuiz.ts)}d ago. Vary question style this round._`,
        );
        lines.push('');
      }

      lines.push(
        '**Reply with:** `1` | `2` | `3` | `parked` | new concept name | `done` to skip',
      );
      lines.push('');
      lines.push(
        '**Then:** `coach_quiz(...)` for active recall, or `enter_state("recon")` for a deeper research excursion.',
      );

      return success(lines.join('\n'));
    },
  );
  state.registerTool('coach_resume', 'coach', resumeHandle);

  // -- coach_quiz ------------------------------------------------------
  // Records one Q+A round. Bloom level + question style + assessment so
  // the next round can vary. No score; just signal.

  const quizHandle = server.registerTool(
    'coach_quiz',
    {
      description:
        'Record one quiz round. Captures concept, question, user answer, Bloom level (1-6: Remember / Understand / Apply / Analyze / Evaluate / Create), question style, and an assessment. Vary `style` across rounds. If `assessment` is "weak" or "partial", follow with `coach_gap` and `coach_revisit`.',
      inputSchema: {
        concept: z.string().describe('The concept being tested (short noun phrase).'),
        question: z.string().describe('The question asked.'),
        user_answer: z
          .string()
          .describe("The user's response, captured verbatim or summarized."),
        bloom_level: z
          .coerce.number()
          .int()
          .min(1)
          .max(6)
          .describe('1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create.'),
        style: z
          .enum(['concept', 'scenario', 'debug', 'predict', 'teach_back', 'simulate_call'])
          .describe(
            'Rotate styles across rounds. concept=definitional; scenario=situational; debug=symptom->cause; predict=forecast; teach_back=Feynman; simulate_call=role-play.',
          ),
        assessment: z
          .enum(['strong', 'partial', 'weak'])
          .describe('Rough signal, not a grade. weak/partial -> record a gap.'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      const finding = `[coach:quiz] ${args.concept} | bloom=L${args.bloom_level} style=${args.style} -> ${args.assessment}\nQ: ${args.question}\nA: ${args.user_answer}`;
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'coach');
      }

      const next =
        args.assessment === 'strong'
          ? 'Adaptive jump: next question one Bloom level up, different style.'
          : args.assessment === 'partial'
            ? '`coach_gap` to record what was fuzzy, then re-quiz with `teach_back` style.'
            : '`coach_gap` to record the gap, then `coach_revisit` to schedule.';

      return success(`Quiz recorded.\n\n**Next:** ${next}`);
    },
  );
  state.registerTool('coach_quiz', 'coach', quizHandle);

  // -- coach_gap -------------------------------------------------------
  // Feynman gap entry: what the user said vs. what's correct, classified.

  const gapHandle = server.registerTool(
    'coach_gap',
    {
      description:
        'Record a Feynman-style gap. Capture what the user said vs. what is correct, then classify the gap type so future quizzes can target the underlying mechanism, not just the surface answer. After saving, propose a re-explanation with a different concrete example.',
      inputSchema: {
        concept: z.string().describe('Concept being clarified.'),
        user_said: z
          .string()
          .describe('What the user articulated (verbatim or summarized).'),
        correct: z.string().describe('What is actually correct, with a concrete example.'),
        gap_type: z
          .enum(['mental_model', 'terminology', 'edge_case', 'why', 'connection'])
          .describe(
            'mental_model=structural mismatch; terminology=name/word; edge_case=branch missed; why=motivation/constraint; connection=cross-system link missed.',
          ),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      const finding = `[coach:gap] ${args.concept} | type=${args.gap_type}\nUser said: ${args.user_said}\nCorrect: ${args.correct}`;
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'coach');
      }
      return success(
        `Gap recorded for "${args.concept}" (${args.gap_type}).\n\n**Next:** re-explain with a different concrete example, then \`coach_revisit\` to queue this for a later session.`,
      );
    },
  );
  state.registerTool('coach_gap', 'coach', gapHandle);

  // -- coach_revisit ---------------------------------------------------
  // Queue a concept for later. No date. Cap-3 enforcement happens in
  // coach_resume by surfacing only the 3 most recent. Older entries stay
  // in the audit trail but never produce a backlog cliff.

  const revisitHandle = server.registerTool(
    'coach_revisit',
    {
      description:
        'Queue a concept for a future session. No date, no interval -- `coach_resume` only surfaces the 3 most recent open revisits, so a long silence does not produce a backlog cliff on re-entry. Older entries stay in the audit trail.',
      inputSchema: {
        concept: z.string().describe('Concept to revisit.'),
        reason: z.string().describe('Why -- what was fuzzy, weak, or worth reinforcing.'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      const finding = `[coach:revisit] ${args.concept} -- ${args.reason}`;
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'coach');
      }
      return success(
        `Revisit queued: "${args.concept}".\n\nIt will appear in \`coach_resume\` next session if it is among the 3 most recent.`,
      );
    },
  );
  state.registerTool('coach_revisit', 'coach', revisitHandle);

  // -- coach_thread_park -----------------------------------------------
  // Park a side-thread the user got curious about, so the conversation
  // can pivot without losing the original concept.

  const threadHandle = server.registerTool(
    'coach_thread_park',
    {
      description:
        'Park a side-thread the user got curious about. Use the moment the conversation pivots. Saves the thread so you can come back, then continue with the new direction.',
      inputSchema: {
        thread: z.string().describe('What the user got curious about.'),
        reason: z.string().describe('Why park it -- context for re-entry.'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      const finding = `[coach:thread] ${args.thread} -- ${args.reason}`;
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'coach');
      }
      return success(
        `Thread parked: "${args.thread}".\n\nFollow the new curiosity. \`coach_resume\` will offer this thread back next time.`,
      );
    },
  );
  state.registerTool('coach_thread_park', 'coach', threadHandle);
}

// -- helpers ----------------------------------------------------------

function stripTag(content: string): string {
  return content.replace(/^\[coach:[a-z_]+\]\s*/, '');
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}
