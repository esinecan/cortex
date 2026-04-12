import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CortexState, CortexToolEntry, CortexToolRegistry, FreeExploreEntry, GeneratedPathwayStep } from './types.js';
import { loadState, saveState, appendFreeExploreEntry } from './storage.js';
import { resolveState } from './states.js';
import { loadTask, saveTask } from './storage.js';
import { updateTask } from './tasks.js';

const ALWAYS_ON_STATES = new Set(['always-on']);

const LOOP_SOFT_LIMIT = Number(process.env.CORTEX_LOOP_SOFT) || 200;
const LOOP_HARD_LIMIT = Number(process.env.CORTEX_LOOP_HARD) || 500;

/**
 * The state machine. Manages workflow state, tool visibility gating, and
 * task state-history tracking. Persists to disk so sessions can resume.
 */
export class StateManager {
  private state: CortexState;
  private registry: CortexToolRegistry = new Map();
  private server: McpServer | null = null;
  private freeExploreEnteredAt: string | null = null;
  private toolCallCount: number = 0;
  private loopWarningEmitted: boolean = false;

  constructor() {
    const saved = loadState();
    this.state = saved || {
      current_state: 'base',
      current_level: null,
      active_task: null,
      previous_state: null,
      previous_level: null,
      session_started: new Date().toISOString(),
    };
  }

  /** Wire up the MCP server so we can send toolListChanged notifications. */
  setServer(server: McpServer): void {
    this.server = server;
  }

  /** Register a native or proxied tool with its state assignment. */
  registerTool(name: string, state: string, handle: CortexToolEntry['handle']): void {
    this.registry.set(name, { name, state, handle });
  }

  /**
   * Record a tool call for loop detection. Returns a loop status that the caller
   * can embed in the tool response if needed.
   */
  recordToolCall(toolName: string): { loopSuspected: boolean; warning?: string } {
    this.toolCallCount++;

    if (this.toolCallCount >= LOOP_HARD_LIMIT) {
      return {
        loopSuspected: true,
        warning: `LOOP_SUSPECTED: ${this.toolCallCount} tool calls in this session without state transition. Consider entering a different state or completing the task.`,
      };
    }

    if (this.toolCallCount >= LOOP_SOFT_LIMIT && !this.loopWarningEmitted) {
      this.loopWarningEmitted = true;
      const taskId = this.state.active_task;
      if (taskId) {
        updateTask(taskId, {
          findings: `[loop-warning] ${this.toolCallCount} tool calls since last state transition. Possible loop detected. Last tool: ${toolName}`,
        }, this.state.current_state);
      }
      return { loopSuspected: false, warning: `Loop warning: ${this.toolCallCount} tool calls without state transition.` };
    }

    return { loopSuspected: false };
  }

  /** Current tool call count (for testing). */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  getState(): CortexState {
    return { ...this.state };
  }

  getCurrentState(): string {
    return this.state.current_state;
  }

  getCurrentLevel(): number | null {
    return this.state.current_level;
  }

  getActiveTaskId(): string | null {
    return this.state.active_task;
  }

  /** Markdown summary of the previous session, or null on first run. */
  getSessionSummary(): string | null {
    const saved = loadState();
    if (!saved) return null;

    const lines = [
      `**Previous session:** ${saved.session_started}`,
      `**State:** ${saved.current_state}${saved.current_level ? ` L${saved.current_level}` : ''}`,
    ];
    if (saved.active_task) {
      lines.push(`**Active task:** ${saved.active_task}`);
    }
    return lines.join('\n');
  }

  /**
   * Transition to a new state. Closes the previous state-history entry on the
   * active task, opens a new one, recomputes tool visibility, and persists.
   * @returns An error message if the state is unknown, or null on success.
   */
  enterState(state: string, taskId?: string, level?: number): string | null {
    const resolved = resolveState(state, level);
    if (!resolved && state !== 'free') return `Unknown state: ${state}`;

    // Close current state history on active task
    this.closeStateHistory();

    const previousState = this.state.current_state;
    this.state.current_state = state;
    this.state.current_level = resolved?.level ?? null;
    this.state.previous_state = previousState;

    // Reset loop counter on state transition
    this.toolCallCount = 0;
    this.loopWarningEmitted = false;

    if (taskId !== undefined) {
      this.state.active_task = taskId;
    }

    // Open new state history on active task
    this.openStateHistory(state);

    // Log if entering a state that mismatches the generated pathway's current step
    const genStep = this.getActiveGeneratedStep();
    if (genStep && genStep.base_state !== state) {
      const taskId = this.state.active_task;
      if (taskId) {
        updateTask(taskId, {
          findings: `[pathway:state-mismatch] Entered "${state}" but current step "${genStep.label}" expects "${genStep.base_state}"`,
        }, state);
      }
    }

    this.applyToolVisibility();
    this.persist();
    return null;
  }

  /**
   * Move to the next level within a leveled state (e.g. validate L1 -> L2).
   * Fails if the state doesn't support levels or is already at max.
   */
  advanceLevel(): { error?: string; level?: number } {
    const currentState = this.state.current_state;
    const currentLevel = this.state.current_level;

    // Check if current state supports levels
    if (!currentLevel) {
      const resolved = resolveState(currentState, 1);
      if (!resolved || !resolved.level) {
        return { error: `State "${currentState}" does not support levels.` };
      }
    }

    const nextLevel = (currentLevel || 1) + 1;
    const resolved = resolveState(currentState, nextLevel);
    if (!resolved) {
      return { error: `Already at max level (${currentLevel}) in state "${currentState}".` };
    }

    this.state.current_level = resolved.level!;
    this.applyToolVisibility();
    this.persist();
    return { level: resolved.level! };
  }

  /**
   * Enter free explore mode. Disables all tools except always-on and discover,
   * logs the escape for analytics, and persists.
   */
  enterFreeExplore(reason?: string): void {
    this.freeExploreEnteredAt = new Date().toISOString();
    const previousState = this.state.current_state;

    this.state.previous_state = previousState;
    this.state.previous_level = this.state.current_level;
    this.state.current_state = 'free';
    this.state.current_level = null;

    // In free explore: only enable always-on + discover tool.
    // Other tools are discoverable and individually enableable.
    // Direct mutation to avoid notification-per-tool flood.
    for (const entry of this.registry.values()) {
      const shouldEnable = ALWAYS_ON_STATES.has(entry.state) || entry.name === 'cortex_discover';
      (entry.handle as any).enabled = shouldEnable;
    }
    this.notifyChanged();

    appendFreeExploreEntry({
      timestamp: this.freeExploreEnteredAt,
      from_state: previousState,
      reason: reason || null,
      task_id: this.state.active_task,
      duration_seconds: null,
    });

    this.persist();
  }

  /** Exit free explore, return to the previous state, and log the duration. */
  exitFreeExplore(): string {
    const returnState = this.state.previous_state || 'base';
    const duration = this.freeExploreEnteredAt
      ? Math.round((Date.now() - new Date(this.freeExploreEnteredAt).getTime()) / 1000)
      : null;

    // Update duration in the last log entry
    if (duration !== null) {
      // We append a corrected entry -- the JSONL is append-only
      appendFreeExploreEntry({
        timestamp: this.freeExploreEnteredAt!,
        from_state: this.state.previous_state || 'base',
        reason: null,
        task_id: this.state.active_task,
        duration_seconds: duration,
      });
    }

    this.freeExploreEnteredAt = null;
    this.state.current_state = returnState;
    this.state.current_level = this.state.previous_level;
    this.state.previous_state = 'free';
    this.state.previous_level = null;

    this.applyToolVisibility();
    this.persist();
    return returnState;
  }

  /** Return to base state, closing any open state-history entry. */
  exitState(): void {
    this.closeStateHistory();
    this.state.previous_state = this.state.current_state;
    this.state.current_state = 'base';
    this.state.current_level = null;
    this.applyToolVisibility();
    this.persist();
  }

  /**
   * List all registered tools with their state assignment and enabled status.
   * Used by cortex_discover in free explore.
   */
  listAllTools(): Array<{ name: string; state: string; enabled: boolean; description?: string }> {
    const result: Array<{ name: string; state: string; enabled: boolean }> = [];
    for (const entry of this.registry.values()) {
      result.push({
        name: entry.name,
        state: entry.state,
        enabled: entry.handle.enabled,
      });
    }
    return result.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  }

  /**
   * Enable specific tools by name. Used by cortex_discover in free explore.
   * Returns count of newly enabled tools.
   */
  enableTools(names: string[]): { enabled: number; notFound: string[] } {
    let enabled = 0;
    const notFound: string[] = [];
    for (const name of names) {
      const entry = this.registry.get(name);
      if (!entry) {
        notFound.push(name);
      } else if (!entry.handle.enabled) {
        entry.handle.enable();
        enabled++;
      }
    }
    if (enabled > 0) this.notifyChanged();
    return { enabled, notFound };
  }

  /**
   * Disable specific tools by name. Used to release tools after use in free explore.
   */
  disableTools(names: string[]): number {
    let disabled = 0;
    for (const name of names) {
      const entry = this.registry.get(name);
      if (entry && entry.handle.enabled && !ALWAYS_ON_STATES.has(entry.state) && entry.name !== 'cortex_discover') {
        entry.handle.disable();
        disabled++;
      }
    }
    if (disabled > 0) this.notifyChanged();
    return disabled;
  }

  /**
   * Get the active step from the current task's generated pathway, if any.
   */
  getActiveGeneratedStep(): GeneratedPathwayStep | null {
    if (!this.state.active_task) return null;
    const task = loadTask(this.state.active_task);
    if (!task?.generated_pathway) return null;
    const gp = task.generated_pathway;
    if (gp.current_step_index < 0 || gp.current_step_index >= gp.steps.length) return null;
    return gp.steps[gp.current_step_index];
  }

  /**
   * Enable/disable tools based on the current state's tool list.
   * Always-on tools stay enabled. Free explore enables everything.
   * When a generated pathway step is active and declares tools, the active set
   * is narrowed to the intersection of state tools and step-declared tools.
   *
   * Uses direct `enabled` property mutation instead of the SDK's `enable()`/`disable()`
   * methods to avoid flooding the client with one `tools/list_changed` notification
   * per tool. A single notification is sent after all visibility changes are applied.
   */
  private applyToolVisibility(): void {
    const state = this.state.current_state;
    const resolved = resolveState(state, this.state.current_level ?? undefined);
    const activeTools = new Set(resolved?.tools || []);

    // Generated pathway step tool scoping
    const genStep = this.getActiveGeneratedStep();
    if (genStep && genStep.tools.length > 0) {
      const stepTools = new Set(genStep.tools);
      if (state === 'free') {
        // Free state has empty resolved tools. Use declared tools directly.
        activeTools.clear();
        for (const tool of stepTools) activeTools.add(tool);
      } else {
        // Intersect: keep only tools declared by the step
        for (const tool of activeTools) {
          if (!stepTools.has(tool)) activeTools.delete(tool);
        }
      }
    }

    for (const entry of this.registry.values()) {
      const shouldEnable = ALWAYS_ON_STATES.has(entry.state)
        || (state === 'free' && !(genStep && genStep.tools.length > 0))
        || activeTools.has(entry.name);

      // Directly mutate the enabled flag to avoid per-tool notification spam.
      (entry.handle as any).enabled = shouldEnable;
    }

    this.notifyChanged();
  }

  private notifyChanged(): void {
    if (this.server) {
      (this.server as any).sendToolListChanged?.();
    }
  }

  private persist(): void {
    saveState(this.state);
  }

  private closeStateHistory(): void {
    if (!this.state.active_task) return;
    const task = loadTask(this.state.active_task);
    if (!task) return;

    const openEntry = task.state_history.find(e => e.exited === null);
    if (openEntry) {
      openEntry.exited = new Date().toISOString();
      saveTask(task);
    }
  }

  private openStateHistory(state: string): void {
    if (!this.state.active_task) return;
    const task = loadTask(this.state.active_task);
    if (!task) return;

    task.state_history.push({
      state,
      entered: new Date().toISOString(),
      exited: null,
    });
    saveTask(task);
  }
}
