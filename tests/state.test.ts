import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTasksDir } from '../src/storage.js';
import { StateManager } from '../src/state.js';
import { loadStates } from '../src/states.js';
import { loadPathways } from '../src/pathways.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

describe('StateManager', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-test-'));
    setTasksDir(tmpDir);
    loadStates(join(PROJECT_ROOT, 'states.yaml'));
    loadPathways(join(PROJECT_ROOT, 'pathways.yaml'));
    state = new StateManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initial state', () => {
    it('starts in base state', () => {
      expect(state.getCurrentState()).toBe('base');
    });

    it('has no active task', () => {
      expect(state.getActiveTaskId()).toBeNull();
    });

    it('has no current level', () => {
      expect(state.getCurrentLevel()).toBeNull();
    });

    it('returns full state object', () => {
      const s = state.getState();
      expect(s.current_state).toBe('base');
      expect(s.active_task).toBeNull();
      expect(s.previous_state).toBeNull();
      expect(s.session_started).toBeTruthy();
    });
  });

  describe('enterState', () => {
    it('transitions to a valid state', () => {
      const err = state.enterState('recon');
      expect(err).toBeNull();
      expect(state.getCurrentState()).toBe('recon');
    });

    it('returns error for unknown state', () => {
      const err = state.enterState('nonexistent');
      expect(err).toBe('Unknown state: nonexistent');
    });

    it('tracks previous state', () => {
      state.enterState('recon');
      state.enterState('plan');
      const s = state.getState();
      expect(s.current_state).toBe('plan');
      expect(s.previous_state).toBe('recon');
    });

    it('associates a task ID', () => {
      state.enterState('recon', 'task-abc');
      expect(state.getActiveTaskId()).toBe('task-abc');
    });

    it('sets level for leveled states', () => {
      const err = state.enterState('validate', undefined, 2);
      expect(err).toBeNull();
      expect(state.getCurrentLevel()).toBe(2);
    });

    it('allows entering free state', () => {
      const err = state.enterState('free');
      expect(err).toBeNull();
      expect(state.getCurrentState()).toBe('free');
    });
  });

  describe('exitState', () => {
    it('returns to base state', () => {
      state.enterState('debug');
      state.exitState();
      expect(state.getCurrentState()).toBe('base');
    });

    it('tracks previous state as the one exited from', () => {
      state.enterState('debug');
      state.exitState();
      expect(state.getState().previous_state).toBe('debug');
    });

    it('clears level on exit', () => {
      state.enterState('validate', undefined, 2);
      state.exitState();
      expect(state.getCurrentLevel()).toBeNull();
    });
  });

  describe('advanceLevel', () => {
    it('advances from L1 to L2 in a leveled state', () => {
      state.enterState('validate', undefined, 1);
      const result = state.advanceLevel();
      expect(result.level).toBe(2);
      expect(result.error).toBeUndefined();
    });

    it('advances from L2 to L3', () => {
      state.enterState('validate', undefined, 2);
      const result = state.advanceLevel();
      expect(result.level).toBe(3);
    });

    it('errors at max level', () => {
      state.enterState('validate', undefined, 3);
      const result = state.advanceLevel();
      expect(result.error).toBeDefined();
    });

    it('errors for non-leveled state', () => {
      state.enterState('recon');
      const result = state.advanceLevel();
      expect(result.error).toBeDefined();
    });
  });

  describe('free explore', () => {
    it('enters free explore mode', () => {
      state.enterState('debug');
      state.enterFreeExplore('testing');
      expect(state.getCurrentState()).toBe('free');
    });

    it('exits free explore and returns to previous state', () => {
      state.enterState('debug');
      state.enterFreeExplore('testing');
      const returnState = state.exitFreeExplore();
      expect(returnState).toBe('debug');
      expect(state.getCurrentState()).toBe('debug');
    });

    it('defaults to base on exit if no previous state', () => {
      state.enterFreeExplore();
      const returnState = state.exitFreeExplore();
      expect(returnState).toBe('base');
    });
  });

  describe('loop detection', () => {
    it('returns no warning initially', () => {
      const result = state.recordToolCall('some_tool');
      expect(result.loopSuspected).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it('resets counter on state transition', () => {
      for (let i = 0; i < 10; i++) state.recordToolCall('tool');
      expect(state.getToolCallCount()).toBe(10);
      state.enterState('recon');
      expect(state.getToolCallCount()).toBe(0);
    });
  });

  describe('tool registration and visibility', () => {
    it('registers and lists tools', () => {
      // Simulate tool registration with a mock handle
      const mockHandle = {
        enabled: true,
        enable: function () {
          this.enabled = true;
        },
        disable: function () {
          this.enabled = false;
        },
      };
      state.registerTool('test_tool', 'recon', mockHandle as any);
      const tools = state.listAllTools();
      expect(tools.find((t) => t.name === 'test_tool')).toBeTruthy();
    });

    it('enables tools by name', () => {
      const mockHandle = {
        enabled: false,
        enable: function () {
          this.enabled = true;
        },
        disable: function () {
          this.enabled = false;
        },
      };
      state.registerTool('test_tool', 'recon', mockHandle as any);
      const result = state.enableTools(['test_tool']);
      expect(result.enabled).toBe(1);
      expect(result.notFound).toHaveLength(0);
    });

    it('reports not found for unknown tools', () => {
      const result = state.enableTools(['nonexistent']);
      expect(result.notFound).toEqual(['nonexistent']);
    });

    it('disables tools by name', () => {
      const mockHandle = {
        enabled: true,
        enable: function () {
          this.enabled = true;
        },
        disable: function () {
          this.enabled = false;
        },
      };
      state.registerTool('test_tool', 'recon', mockHandle as any);
      const count = state.disableTools(['test_tool']);
      expect(count).toBe(1);
    });
  });

  describe('session summary', () => {
    it('returns null on first run (no saved state)', () => {
      // Constructor does not persist state, so a fresh tmpDir has no _state.json
      const summary = state.getSessionSummary();
      expect(summary).toBeNull();
    });

    it('includes state and session info', () => {
      state.enterState('debug');
      const newState = new StateManager(); // loads saved state
      const summary = newState.getSessionSummary();
      expect(summary).toContain('debug');
    });
  });
});
