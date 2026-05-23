import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type {
  CortexState,
  CortexToolEntry,
  CortexToolRegistry,
  GeneratedPathwayStep,
} from './types.js';
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
  /**
   * Populated by the setServer interceptor: every server.registerTool call
   * stashes its description + inputSchema here, keyed by tool name. The
   * subsequent state.registerTool call shallow-merges this captured meta
   * with any explicit meta, so the dispatcher (cortex_call / cortex_describe)
   * can surface schemas without touching native call sites.
   */
  private capturedMeta: Map<string, { description?: string; schema?: ZodRawShape }> = new Map();

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

  /**
   * Wire up the MCP server, and intercept registerTool so every tool's
   * description + inputSchema is captured for the dispatcher.
   *
   * The dispatcher (cortex_call / cortex_describe) needs the schema to
   * describe tools and the description to render rich output. We capture at
   * registration time so we don't have to thread meta through ~50 native
   * call sites.
   */
  setServer(server: McpServer): void {
    this.server = server;
    const original = server.registerTool.bind(server);
    (server as any).registerTool = (
      name: string,
      def: { description?: string; inputSchema?: ZodRawShape; [k: string]: unknown },
      handler: any,
    ) => {
      const handle = (original as any)(name, def, handler);
      this.capturedMeta.set(name, {
        description: def?.description,
        schema: def?.inputSchema,
      });
      return handle;
    };
  }

  /**
   * Register a native or proxied tool with its state assignment.
   *
   * Installs a call-time gate by wrapping the tool's handler. The tool stays
   * advertised in `tools/list` always (enabled=true); gating happens on invoke.
   * When a tool is called outside its allowed state, the wrapper returns a
   * text response pointing to the state that enables it.
   *
   * This avoids the old mechanism (flipping enabled=false on transitions) which
   * caused Claude Code to report every state change as "MCP server disconnected"
   * for all tools that vanished from tools/list.
   */
  registerTool(
    name: string,
    state: string,
    handle: CortexToolEntry['handle'],
    meta?: { description?: string; schema?: ZodRawShape },
  ): void {
    const originalHandler = (handle as any).handler as (args: any, extra: any) => any;
    (handle as any).handler = async (args: any, extra: any) => {
      if (!this.isToolAllowed(name)) {
        const current = this.state.current_state;
        const enabling = state.split(':')[0];
        return {
          content: [
            {
              type: 'text',
              text:
                `Tool \`${name}\` is gated off in state \`${current}\`. ` +
                `It belongs to state \`${enabling}\`. ` +
                `Call \`enter_state("${enabling}")\` to enable it, or \`cortex_discover\` to list alternatives.`,
            },
          ],
        };
      }
      return originalHandler(args, extra);
    };
    // Shallow-merge: captured meta (from the setServer interceptor) supplies
    // defaults; explicit meta overrides field-by-field. Without the merge,
    // passing meta with only `description` would silently drop the captured
    // schema.
    const captured = this.capturedMeta.get(name) ?? {};
    const finalMeta = { ...captured, ...(meta ?? {}) };
    this.registry.set(name, { name, state, handle, ...finalMeta });
  }

  /** Lookup used by the dispatcher (cortex_call / cortex_describe). */
  getRegistryEntry(name: string): CortexToolEntry | undefined {
    return this.registry.get(name);
  }

  /**
   * Pure predicate: is this tool callable given the current state, level, and
   * active generated pathway step? Used by the call-time gate wrapper in
   * `registerTool`. Does not mutate anything.
   */
  isToolAllowed(toolName: string): boolean {
    const entry = this.registry.get(toolName);
    if (!entry) return true; // unknown tool: let it through, handler will 404
    if (ALWAYS_ON_STATES.has(entry.state)) return true;

    const current = this.state.current_state;
    const resolved = resolveState(current, this.state.current_level ?? undefined);
    const activeTools = new Set(resolved?.tools || []);
    const genStep = this.getActiveGeneratedStep();

    if (genStep && genStep.tools.length > 0) {
      const stepTools = new Set(genStep.tools);
      if (current === 'free') return stepTools.has(toolName);
      return activeTools.has(toolName) && stepTools.has(toolName);
    }

    if (current === 'free') return true;

    // The `:discoverable` suffix marks proxied tools that are auto-allowed
    // whenever their base state is active (regardless of the level's tool
    // list). Native tools register with a bare state name and must appear
    // explicitly in the resolved state's tool list — so level-narrowing
    // continues to work for leveled states like triage L1 → L2 → L3.
    const baseState = entry.state.split(':')[0];
    const isDiscoverable = entry.state !== baseState;
    return activeTools.has(toolName) || (isDiscoverable && baseState === current);
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
        updateTask(
          taskId,
          {
            findings: `[loop-warning] ${this.toolCallCount} tool calls since last state transition. Possible loop detected. Last tool: ${toolName}`,
          },
          this.state.current_state,
        );
      }
      return {
        loopSuspected: false,
        warning: `Loop warning: ${this.toolCallCount} tool calls without state transition.`,
      };
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

  /**
   * One-line location breadcrumb for embedding in tool responses.
   * Format: `[state | task: id | pathway step X/Y]` or `[state]` if minimal.
   */
  breadcrumb(): string {
    const parts: string[] = [];

    // State + level
    const level = this.state.current_level ? ` L${this.state.current_level}` : '';
    parts.push(`${this.state.current_state}${level}`);

    // Active task
    if (this.state.active_task) {
      parts.push(`task: ${this.state.active_task}`);

      // Pathway progress
      const task = loadTask(this.state.active_task);
      if (task?.generated_pathway) {
        const gp = task.generated_pathway;
        const done = gp.steps.filter((s) => s.status === 'completed').length;
        parts.push(`step ${gp.current_step_index}/${gp.steps.length} (${done} done)`);
      } else if (task?.pathway) {
        parts.push(task.pathway);
      }
    }

    return `> [${parts.join(' | ')}]`;
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
        updateTask(
          taskId,
          {
            findings: `[pathway:state-mismatch] Entered "${state}" but current step "${genStep.label}" expects "${genStep.base_state}"`,
          },
          state,
        );
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
   * Enter free explore mode. Under the call-gate model, free state simply
   * relaxes the call-time gate so every registered tool is allowed.
   * No SDK-level enable/disable flips happen here — the tool catalog stays
   * stable to avoid the "MCP server disconnected" signal.
   */
  enterFreeExplore(reason?: string): void {
    this.freeExploreEnteredAt = new Date().toISOString();
    const previousState = this.state.current_state;

    this.state.previous_state = previousState;
    this.state.previous_level = this.state.current_level;
    this.state.current_state = 'free';
    this.state.current_level = null;

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
   * Under the call-gate model, tools stay enabled in the SDK catalog at all
   * times. This method is a reporting no-op kept for cortex_discover's
   * API shape: it reports which names were recognized and how many are
   * currently callable per `isToolAllowed`. No SDK flags are mutated.
   */
  enableTools(names: string[]): { enabled: number; notFound: string[] } {
    let enabled = 0;
    const notFound: string[] = [];
    for (const name of names) {
      const entry = this.registry.get(name);
      if (!entry) {
        notFound.push(name);
      } else if (this.isToolAllowed(name)) {
        enabled++;
      }
    }
    return { enabled, notFound };
  }

  /**
   * Reporting no-op. See `enableTools`.
   */
  disableTools(names: string[]): number {
    let count = 0;
    for (const name of names) {
      const entry = this.registry.get(name);
      if (entry && !ALWAYS_ON_STATES.has(entry.state) && entry.name !== 'cortex_discover') {
        count++;
      }
    }
    return count;
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
   * Gating is enforced at call-time by the wrapper installed in `registerTool`.
   * This method is intentionally a no-op for SDK-level visibility.
   *
   * The old implementation flipped `handle.enabled` across the registry on every
   * state transition. That removed tools from `tools/list`, which Claude Code
   * reports as "MCP server disconnected" for each vanished tool. Under the new
   * call-gate model the tool catalog stays stable; `isToolAllowed()` decides
   * per-call whether to dispatch or return a gating hint.
   *
   * Kept as a method (not deleted) so callers that announce a state transition
   * have one place to grow into — e.g. diagnostics, metrics, annotations — if
   * we reintroduce visibility signalling later via a different channel.
   */
  private applyToolVisibility(): void {
    // no-op: call-gate enforces state, catalog stays stable.
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

    const openEntry = task.state_history.find((e) => e.exited === null);
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
