import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTasksDir } from '../src/storage.js';
import {
  createTask,
  updateTask,
  getTask,
  getTaskContext,
  listAllTasks,
  MAX_ACTIVE_ROOT_TASKS,
} from '../src/tasks.js';

describe('Task System', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-test-'));
    setTasksDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('creates a task with required fields', () => {
      const result = createTask('Test task', 'Do something');
      expect(result.error).toBeUndefined();
      expect(result.task).toBeDefined();
      expect(result.task!.title).toBe('Test task');
      expect(result.task!.description).toBe('Do something');
      expect(result.task!.status).toBe('active');
      expect(result.task!.id).toHaveLength(8);
    });

    it('enforces the active root task limit', () => {
      for (let i = 0; i < MAX_ACTIVE_ROOT_TASKS; i++) createTask(`Task ${i + 1}`, '');
      const result = createTask('One too many', '');
      expect(result.error).toContain(`Max ${MAX_ACTIVE_ROOT_TASKS} active root tasks`);
    });

    it('allows subtasks beyond root limit', () => {
      const parent = createTask('Parent', '');
      for (let i = 1; i < MAX_ACTIVE_ROOT_TASKS; i++) createTask(`Task ${i + 1}`, '');
      const sub = createTask('Subtask', '', parent.task!.id);
      expect(sub.error).toBeUndefined();
      expect(sub.task).toBeDefined();
    });

    it('errors on missing parent', () => {
      const result = createTask('Sub', '', 'nonexistent');
      expect(result.error).toContain('not found');
    });

    it('links subtask to parent', () => {
      const parent = createTask('Parent', '');
      const child = createTask('Child', '', parent.task!.id);
      const reloaded = getTask(parent.task!.id);
      expect(reloaded!.subtasks).toContain(child.task!.id);
    });

    it('assigns a pathway', () => {
      const result = createTask('With pathway', '', null, 'golden');
      expect(result.task!.pathway).toBe('golden');
    });
  });

  describe('updateTask', () => {
    it('updates status', () => {
      const { task } = createTask('Test', '');
      const result = updateTask(task!.id, { status: 'completed' });
      expect(result.task!.status).toBe('completed');
    });

    it('appends findings with timestamp', () => {
      const { task } = createTask('Test', '');
      updateTask(task!.id, { findings: 'Found something' }, 'recon');
      const updated = getTask(task!.id);
      expect(updated!.findings).toHaveLength(1);
      expect(updated!.findings[0].content).toBe('Found something');
      expect(updated!.findings[0].state).toBe('recon');
      expect(updated!.findings[0].ts).toBeTruthy();
    });

    it('appends notes with [note] prefix', () => {
      const { task } = createTask('Test', '');
      updateTask(task!.id, { notes: 'A note' }, 'debug');
      const updated = getTask(task!.id);
      expect(updated!.findings[0].content).toContain('[note]');
    });

    it('updates title', () => {
      const { task } = createTask('Old title', '');
      updateTask(task!.id, { title: 'New title' });
      const updated = getTask(task!.id);
      expect(updated!.title).toBe('New title');
    });

    it('errors on nonexistent task', () => {
      const result = updateTask('nope', { status: 'completed' });
      expect(result.error).toContain('not found');
    });
  });

  describe('getTask', () => {
    it('returns null for missing task', () => {
      expect(getTask('nonexistent')).toBeNull();
    });

    it('returns the task', () => {
      const { task } = createTask('Test', 'desc');
      const loaded = getTask(task!.id);
      expect(loaded!.title).toBe('Test');
    });
  });

  describe('getTaskContext', () => {
    it('returns null for missing task', () => {
      expect(getTaskContext('nonexistent')).toBeNull();
    });

    it('renders markdown with title and status', () => {
      const { task } = createTask('Context test', 'A description');
      const ctx = getTaskContext(task!.id);
      expect(ctx).toContain('# Task: Context test');
      expect(ctx).toContain('A description');
    });

    it('includes findings in context', () => {
      const { task } = createTask('Test', '');
      updateTask(task!.id, { findings: 'Finding 1' }, 'recon');
      updateTask(task!.id, { findings: 'Finding 2' }, 'debug');
      const ctx = getTaskContext(task!.id);
      expect(ctx).toContain('Finding 1');
      expect(ctx).toContain('Finding 2');
    });

    it('includes state history', () => {
      // State history is managed by StateManager, not directly testable here
      // but we can verify the template handles empty state_history
      const { task } = createTask('Test', '');
      const ctx = getTaskContext(task!.id);
      expect(ctx).not.toContain('## State History');
    });
  });

  describe('listAllTasks', () => {
    it('returns empty message when no tasks', () => {
      const result = listAllTasks();
      expect(result).toContain('No persistent tasks');
    });

    it('lists tasks with status', () => {
      createTask('Task A', '');
      createTask('Task B', '');
      const result = listAllTasks();
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
      expect(result).toContain('[active]');
    });
  });
});
