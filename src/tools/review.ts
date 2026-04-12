import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond, success } from '../respond.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ReviewPattern {
  theme: string;
  description: string;
  example_trigger: string;
  frequency: string;
}

interface ReviewerProfile {
  philosophy: string;
  communication_style: string;
  repo_focus: string[];
  review_patterns: ReviewPattern[];
  checklist: string[];
}

interface TeamStandard {
  rule: string;
  prevention_stage: string;
  evidence: string[];
}

interface ReviewerPatterns {
  profiles: Record<string, ReviewerProfile>;
  team_standards: TeamStandard[];
}

function loadReviewerPatterns(): ReviewerPatterns | null {
  const patternsPath = resolve(__dirname, '../../reviewer-patterns.json');
  if (!existsSync(patternsPath)) return null;
  return JSON.parse(readFileSync(patternsPath, 'utf-8'));
}

function formatReviewerSimulation(name: string, profile: ReviewerProfile): string {
  const lines: string[] = [
    `## Simulated Review: ${name}`,
    '',
    `**${profile.philosophy}**`,
    '',
    `*Style: ${profile.communication_style}*`,
    `*Strongest on: ${profile.repo_focus.join(', ')}*`,
    '',
    '---',
    '',
    '### Stage 1: Pattern Review',
    '',
    "Read the diff through this reviewer's lens. These are the patterns they catch most often:",
    '',
  ];

  for (const pattern of profile.review_patterns) {
    const freq =
      pattern.frequency === 'high' ? '[high]' : pattern.frequency === 'medium' ? '[med]' : '[low]';
    lines.push(`**${freq} ${pattern.theme}**`);
    lines.push(`${pattern.description}`);
    lines.push(`> *Trigger:* ${pattern.example_trigger}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('### Stage 2: Checklist');
  lines.push('');
  lines.push('After reviewing the diff against the patterns above, verify each item:');
  lines.push('');
  for (const item of profile.checklist) {
    lines.push(`- [ ] ${item}`);
  }

  return lines.join('\n');
}

/**
 * Review tools: diff summaries, reviewer simulation, standards checklist,
 * and PR readiness gating. Reviewer profiles loaded from reviewer-patterns.json if present.
 */
export function registerReviewTools(server: McpServer, state: StateManager): void {
  const diffSummaryHandle = server.registerTool(
    'review_diff_summary',
    {
      description:
        'Generate a summary of all changes in the working tree. Run this first in review state.',
      inputSchema: {
        repo_path: z
          .string()
          .optional()
          .describe('Path to the git repository (default: current directory)'),
      },
    },
    async (args) => {
      const repoPath = args.repo_path || '.';
      try {
        const stat = execSync('git diff --stat', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 10_000,
        });
        const diff = execSync('git diff', { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 });

        if (!stat.trim()) {
          return success(
            '## Review: Diff Summary\n\nNo unstaged changes found. Check if changes are already staged (`git diff --cached`).',
          );
        }

        return respond(
          state,
          [
            '## Review: Diff Summary',
            '',
            '### Files Changed',
            '```',
            stat.trim(),
            '```',
            '',
            '### Full Diff',
            '```diff',
            diff.trim(),
            '```',
          ].join('\n'),
          '`review_simulate` to get reviewer perspectives, then `review_checklist`.',
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return success(
          `## Review: Diff Summary\n\nFailed to read diff: ${msg}\n\nFallback: run \`cd ${repoPath} && git diff --stat && git diff\` manually.`,
        );
      }
    },
  );
  state.registerTool('review_diff_summary', 'review', diffSummaryHandle);

  const simulateHandle = server.registerTool(
    'review_simulate',
    {
      description:
        'Simulate a specific reviewer perspective on the changes. Two-stage output: first review patterns (what this reviewer catches most), then a targeted checklist.',
      inputSchema: {
        reviewer: z
          .string()
          .describe(
            'Reviewer archetype (e.g. "surgeon", "guardian", "architect") or custom role (e.g. "senior-security", "pedantic-types")',
          ),
      },
    },
    async (args) => {
      const patterns = loadReviewerPatterns();
      const name = args.reviewer.toLowerCase();

      if (patterns) {
        const profile = patterns.profiles[name];
        if (profile) {
          return success(formatReviewerSimulation(args.reviewer, profile));
        }
      }

      // Generic fallback for any reviewer archetype
      return success(
        [
          `## Simulated Review: ${args.reviewer}`,
          '',
          `Reviewing as ${args.reviewer}. Focus on: correctness, edge cases, maintainability, security.`,
          '',
          '### Review Checklist',
          '- [ ] All changed files read and understood',
          '- [ ] Edge cases identified',
          '- [ ] Error handling verified',
          '- [ ] Test coverage adequate',
          '- [ ] No security vulnerabilities introduced',
          '- [ ] Backward compatible (or breaking change documented)',
          '',
          'Use `review_checklist` for the full standards check.',
        ].join('\n'),
      );
    },
  );
  state.registerTool('review_simulate', 'review', simulateHandle);

  const checklistHandle = server.registerTool(
    'review_checklist',
    {
      description: 'Run the standards checklist for production-ready code.',
    },
    async () => {
      const patterns = loadReviewerPatterns();

      const teamStandardLines = patterns
        ? patterns.team_standards.map((s) => `- [ ] [${s.prevention_stage}] ${s.rule}`)
        : [];

      return success(
        [
          '## PR Review Checklist',
          '',
          ...(teamStandardLines.length > 0
            ? ['### Team Standards (from reviewer-patterns.json)', ...teamStandardLines, '']
            : []),
          '### Code Quality',
          '- [ ] Database mutations are wrapped in appropriate transactions',
          '- [ ] Input validated at system boundaries',
          '- [ ] No hardcoded credentials or secrets',
          '- [ ] Error messages are actionable',
          '- [ ] Logging is adequate for debugging',
          '',
          '### PR Prep',
          '- [ ] Diff is focused (no unrelated changes)',
          '- [ ] Commit messages are descriptive',
          '- [ ] Tests pass locally',
          '- [ ] No TODO/FIXME without ticket references',
          '- [ ] Types are explicit (no implicit any)',
          '',
          'Call `review_ready` when all checks pass.',
        ].join('\n'),
      );
    },
  );
  state.registerTool('review_checklist', 'review', checklistHandle);

  const readyHandle = server.registerTool(
    'review_ready',
    {
      description: 'Mark as ready for PR creation.',
      inputSchema: {
        summary: z.string().optional().describe('Brief summary of what changed and why'),
      },
    },
    async (args) => {
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: `[review-ready] ${args.summary || 'PR ready'}` }, 'review');
      }

      return respond(
        state,
        [
          '## Ready for PR',
          '',
          args.summary ? `**Summary:** ${args.summary}\n` : '',
          'Next steps:',
          '1. Create the PR',
          '2. Or commit if not yet committed',
        ].join('\n'),
      );
    },
  );
  state.registerTool('review_ready', 'review', readyHandle);
}
