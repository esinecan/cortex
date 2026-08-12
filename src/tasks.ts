/**
 * Task lifecycle operations. Tasks are the persistent unit of work in cortex -- they
 * accumulate findings across states and sessions, enforce a root task limit, and
 * support parent/subtask hierarchy.
 * @module
 */
import { randomUUID } from 'node:crypto';
import type { PersistentTask, TaskStatus, TaskFinding, GeneratedPathway } from './types.js';
import { loadTask, saveTask, listTasks } from './storage.js';

export const MAX_ACTIVE_ROOT_TASKS = 7;
const FINDINGS_PAGE_SIZE = 50;

/**
 * Create a new persistent task. Enforces a max of 7 active root tasks.
 * @param pathway - Optional pathway name to get guided workflow steps.
 * @returns The created task, or an error if the limit is hit or a parent is missing.
 */
export function createTask(
  title: string,
  description: string,
  parentId: string | null = null,
  pathway: string | null = null,
): { task?: PersistentTask; error?: string } {
  if (!parentId) {
    const active = listTasks().filter((t) => !t.parent && t.status === 'active');
    if (active.length >= MAX_ACTIVE_ROOT_TASKS) {
      const listing = active.map((t) => `  - ${t.id}: ${t.title} (since ${t.created})`).join('\n');
      return {
        error: `Max ${MAX_ACTIVE_ROOT_TASKS} active root tasks. Current:\n${listing}\n\nPause or complete one before creating a new task.`,
      };
    }
  }

  if (parentId) {
    const parent = loadTask(parentId);
    if (!parent) return { error: `Parent task ${parentId} not found.` };
  }

  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const task: PersistentTask = {
    id,
    title,
    description,
    created: now,
    updated: now,
    status: 'active',
    parent: parentId,
    pathway: pathway,
    state_history: [],
    findings: [],
    subtasks: [],
  };

  saveTask(task);

  if (parentId) {
    const parent = loadTask(parentId)!;
    parent.subtasks.push(id);
    saveTask(parent);
  }

  return { task };
}

/**
 * Update an existing task. Findings and notes are appended with timestamps and
 * tagged with the current state so the audit trail shows where each entry came from.
 */
export function updateTask(
  id: string,
  updates: {
    status?: TaskStatus;
    findings?: string;
    notes?: string;
    title?: string;
  },
  currentState?: string,
): { task?: PersistentTask; error?: string } {
  const task = loadTask(id);
  if (!task) return { error: `Task ${id} not found.` };

  if (updates.status) {
    task.status = updates.status;
  }

  if (updates.title) {
    task.title = updates.title;
  }

  const state = currentState || 'unknown';

  if (updates.findings) {
    const finding: TaskFinding = {
      ts: new Date().toISOString(),
      state,
      content: updates.findings,
    };
    task.findings.push(finding);
  }

  if (updates.notes) {
    const note: TaskFinding = {
      ts: new Date().toISOString(),
      state,
      content: `[note] ${updates.notes}`,
    };
    task.findings.push(note);
  }

  saveTask(task);
  return { task };
}

/** Fetch a task by ID, or null if it doesn't exist. */
export function getTask(id: string): PersistentTask | null {
  return loadTask(id);
}

/**
 * Reconstruct a task's full context as markdown. This is the primary way to
 * resume a task from a previous session -- it includes description, state history,
 * paginated findings, and subtask status.
 *
 * @param page - 1-indexed page number (default 1).
 * @param order - 'newest' returns the most recent findings on page 1;
 *                'oldest' returns the earliest findings on page 1.
 *                Within a page findings are always chronological (oldest->newest).
 */
export function getTaskContext(
  id: string,
  page: number = 1,
  order: 'newest' | 'oldest' = 'newest',
): string | null {
  const task = loadTask(id);
  if (!task) return null;

  const lines: string[] = [
    `# Task: ${task.title}`,
    `**ID:** ${task.id} | **Status:** ${task.status} | **Created:** ${task.created}`,
    '',
    `**Description:** ${task.description}`,
    '',
  ];

  if (task.state_history.length > 0) {
    lines.push('## State History');
    for (const entry of task.state_history) {
      const exited = entry.exited || 'current';
      lines.push(`- ${entry.state}: ${entry.entered} -> ${exited}`);
    }
    lines.push('');
  }

  if (task.findings.length > 0) {
    const total = task.findings.length;
    const totalPages = Math.ceil(total / FINDINGS_PAGE_SIZE);

    if (page > totalPages) {
      lines.push(`## Findings`);
      lines.push(`No findings on page ${page} (total pages: ${totalPages}).`);
      lines.push('');
    } else if (total <= FINDINGS_PAGE_SIZE) {
      lines.push('## Findings');
      for (const f of task.findings) {
        lines.push(`- **[${f.state}] ${f.ts}**: ${f.content}`);
      }
      lines.push('');
    } else {
      let start: number;
      let end: number;

      if (order === 'newest') {
        start = Math.max(0, total - page * FINDINGS_PAGE_SIZE);
        end = total - (page - 1) * FINDINGS_PAGE_SIZE;
      } else {
        start = (page - 1) * FINDINGS_PAGE_SIZE;
        end = Math.min(total, page * FINDINGS_PAGE_SIZE);
      }

      const paginated = task.findings.slice(start, end);
      const orderLabel = order === 'newest' ? 'newest first' : 'oldest first';
      lines.push(
        `## Findings -- Page ${page}/${totalPages} (${paginated.length} of ${total}, ${orderLabel})`,
      );
      lines.push(
        `*\`task_context("${id}", page=${page === 1 ? 2 : page + 1}${order !== 'newest' ? ', order="oldest"' : ''}) for ${page === 1 ? 'more' : 'next page'}\`*`,
      );
      lines.push('');
      for (const f of paginated) {
        lines.push(`- **[${f.state}] ${f.ts}**: ${f.content}`);
      }
      lines.push('');
    }
  }

  if (task.generated_pathway) {
    lines.push(getGeneratedPathwayContext(task.generated_pathway));
  }

  if (task.subtasks.length > 0) {
    lines.push('## Subtasks');
    for (const subId of task.subtasks) {
      const sub = loadTask(subId);
      if (sub) {
        lines.push(`- ${sub.id}: ${sub.title} [${sub.status}]`);
      }
    }
  }

  return lines.join('\n');
}

/** Render a generated pathway as markdown for context reconstruction. */
export function getGeneratedPathwayContext(gp: GeneratedPathway): string {
  const lines: string[] = [
    '## Generated Pathway',
    `**Goal:** ${gp.goal}`,
    `**Progress:** ${gp.steps.filter((s) => s.status === 'completed').length}/${gp.steps.length} steps`,
    `**Enforcement:** ${gp.strict_enforcement ? 'strict' : 'soft'}`,
    '',
  ];

  for (let i = 0; i < gp.steps.length; i++) {
    const step = gp.steps[i];
    const isCurrent = i === gp.current_step_index && step.status === 'active';
    const marker = isCurrent ? '>> ' : '   ';
    const statusIcon =
      step.status === 'completed'
        ? '[done]'
        : step.status === 'active'
          ? '[active]'
          : step.status === 'skipped'
            ? '[skipped]'
            : '[pending]';

    lines.push(`${marker}**Step ${i}: ${step.label}** ${statusIcon} (${step.base_state})`);
    lines.push(`${marker}  ${step.description}`);

    // Criteria progress
    const met = step.criteria_met.length;
    const total = step.acceptance_criteria.length;
    lines.push(`${marker}  Criteria: ${met}/${total}`);
    for (let j = 0; j < step.acceptance_criteria.length; j++) {
      const check = step.criteria_met.includes(j) ? 'x' : ' ';
      lines.push(`${marker}  - [${check}] ${step.acceptance_criteria[j]}`);
    }

    // Proofs
    if (step.proofs.length > 0) {
      lines.push(`${marker}  Proofs:`);
      for (const p of step.proofs) {
        lines.push(`${marker}  - [${p.type}] ${p.description}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/** Render all tasks as a markdown tree with status, finding count, and latest finding preview. */
export function listAllTasks(): string {
  const tasks = listTasks();
  if (tasks.length === 0) return 'No persistent tasks.';

  const roots = tasks.filter((t) => !t.parent);
  const lines: string[] = ['# Persistent Tasks', ''];

  for (const task of roots) {
    const findingCount = task.findings.length;
    const latestFinding = task.findings[task.findings.length - 1];
    const latest = latestFinding ? ` | Last: ${latestFinding.content.slice(0, 80)}` : '';
    lines.push(`- **[${task.status}]** ${task.id}: ${task.title}${latest}`);

    if (findingCount > 0) {
      lines.push(`  (${findingCount} findings)`);
    }

    for (const subId of task.subtasks) {
      const sub = loadTask(subId);
      if (sub) {
        lines.push(`  - **[${sub.status}]** ${sub.id}: ${sub.title}`);
      }
    }
  }

  return lines.join('\n');
}
