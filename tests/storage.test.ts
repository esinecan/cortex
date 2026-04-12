import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setTasksDir,
  loadTask,
  saveTask,
  listTasks,
  deleteTask,
  loadState,
  saveState,
  appendFreeExploreEntry,
  loadFreeExploreLog,
} from '../src/storage.js';
import type { PersistentTask, CortexState } from '../src/types.js';

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  return {
    id: 'test-1',
    title: 'Test Task',
    description: 'A test',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: 'active',
    parent: null,
    pathway: null,
    state_history: [],
    findings: [],
    subtasks: [],
    ...overrides,
  };
}

describe('Storage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-test-'));
    setTasksDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('task storage', () => {
    it('saves and loads a task', () => {
      const task = makeTask();
      saveTask(task);
      const loaded = loadTask('test-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Test Task');
    });

    it('returns null for missing task', () => {
      expect(loadTask('nonexistent')).toBeNull();
    });

    it('updates the updated timestamp on save', () => {
      const task = makeTask({ updated: '2020-01-01T00:00:00Z' });
      saveTask(task);
      const loaded = loadTask('test-1');
      expect(loaded!.updated).not.toBe('2020-01-01T00:00:00Z');
    });

    it('lists all tasks', () => {
      saveTask(makeTask({ id: 'a' }));
      saveTask(makeTask({ id: 'b' }));
      const tasks = listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('deletes a task', () => {
      saveTask(makeTask());
      expect(deleteTask('test-1')).toBe(true);
      expect(loadTask('test-1')).toBeNull();
    });

    it('returns false when deleting nonexistent task', () => {
      expect(deleteTask('nonexistent')).toBe(false);
    });

    it('creates the directory if it does not exist', () => {
      const nested = join(tmpDir, 'nested', 'dir');
      setTasksDir(nested);
      saveTask(makeTask());
      expect(existsSync(join(nested, 'task-test-1.json'))).toBe(true);
    });
  });

  describe('state storage', () => {
    it('returns null when no state is saved', () => {
      expect(loadState()).toBeNull();
    });

    it('saves and loads state', () => {
      const state: CortexState = {
        current_state: 'debug',
        current_level: 2,
        active_task: 'task-abc',
        previous_state: 'recon',
        previous_level: null,
        session_started: new Date().toISOString(),
      };
      saveState(state);
      const loaded = loadState();
      expect(loaded).not.toBeNull();
      expect(loaded!.current_state).toBe('debug');
      expect(loaded!.current_level).toBe(2);
      expect(loaded!.active_task).toBe('task-abc');
    });
  });

  describe('free explore log', () => {
    it('returns empty array when no log exists', () => {
      expect(loadFreeExploreLog()).toEqual([]);
    });

    it('appends and reads entries', () => {
      appendFreeExploreEntry({
        timestamp: new Date().toISOString(),
        from_state: 'debug',
        reason: 'testing',
        task_id: null,
        duration_seconds: null,
      });
      appendFreeExploreEntry({
        timestamp: new Date().toISOString(),
        from_state: 'plan',
        reason: null,
        task_id: 'task-1',
        duration_seconds: 42,
      });

      const log = loadFreeExploreLog();
      expect(log).toHaveLength(2);
      expect(log[0].from_state).toBe('debug');
      expect(log[1].duration_seconds).toBe(42);
    });

    it('is append-only (JSONL format)', () => {
      appendFreeExploreEntry({
        timestamp: '2025-01-01T00:00:00Z',
        from_state: 'base',
        reason: null,
        task_id: null,
        duration_seconds: null,
      });
      const raw = readFileSync(join(tmpDir, '_free_explore_log.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).from_state).toBe('base');
    });
  });
});
