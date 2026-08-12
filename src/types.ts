import type { RegisteredTool } from '@modelcontextprotocol/server';
import type { ZodRawShape } from 'zod';

// -- Task types --

/** Lifecycle status of a persistent task. */
export type TaskStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';

/** A timestamped finding attached to a task, tagged with the state it was recorded in. */
export interface TaskFinding {
  ts: string;
  state: string;
  content: string;
}

/** Tracks when a task entered and exited a given state. Open entries have `exited: null`. */
export interface StateHistoryEntry {
  state: string;
  entered: string;
  exited: string | null;
}

/**
 * A task that persists to disk and survives across sessions.
 * Accumulates findings, tracks state history, and supports parent/subtask hierarchy.
 */
export interface PersistentTask {
  id: string;
  title: string;
  description: string;
  created: string;
  updated: string;
  status: TaskStatus;
  parent: string | null;
  pathway: string | null;
  state_history: StateHistoryEntry[];
  findings: TaskFinding[];
  subtasks: string[];
  generated_pathway?: GeneratedPathway;
}

// -- State types --

/** Tools the agent should use or avoid when in a given state. */
export interface ExternalGuidance {
  use: string[];
  avoid: string[];
}

export interface StateLevel {
  tools: string[];
  external_guidance: ExternalGuidance;
  constraints: string[];
}

/** Raw state definition as loaded from states.yaml. Supports flat tool lists or leveled definitions. */
export interface StateDefinition {
  description: string;
  tools?: string[];
  levels?: Record<
    number,
    {
      tools: string[];
      inherits?: number;
      additional_tools?: string[];
      external_guidance?: ExternalGuidance;
      additional_external_guidance?: { use?: string[] };
      constraints?: string[];
    }
  >;
  skill_suggestions?: string[];
  external_guidance?: ExternalGuidance;
  constraints?: string[];
}

/** Fully resolved state after walking the level inheritance chain (for leveled states). */
export interface ResolvedState {
  name: string;
  description: string;
  tools: string[];
  skill_suggestions: string[];
  external_guidance: ExternalGuidance;
  constraints: string[];
  level?: number;
  max_level?: number;
}

// -- Cortex state --

/** The persisted runtime state of cortex -- current position in the state machine. */
export interface CortexState {
  current_state: string;
  current_level: number | null;
  active_task: string | null;
  previous_state: string | null;
  previous_level: number | null;
  session_started: string;
}

/** Append-only audit log entry for free explore sessions. */
export interface FreeExploreEntry {
  timestamp: string;
  from_state: string;
  reason: string | null;
  task_id: string | null;
  duration_seconds: number | null;
}

// -- Generated pathway types --

/** Proof of completion for a generated pathway step. */
export interface PathwayProof {
  type: 'test_output' | 'screenshot' | 'log_evidence' | 'manual_verification' | 'audit_result';
  description: string;
  timestamp: string;
}

/** A single step in a generated pathway. */
export interface GeneratedPathwayStep {
  id: string;
  label: string;
  base_state: string;
  description: string;
  acceptance_criteria: string[];
  criteria_met: number[];
  tools: string[];
  external_guidance: ExternalGuidance;
  constraints: string[];
  proofs: PathwayProof[];
  status: 'pending' | 'active' | 'completed' | 'skipped';
}

/** A pathway generated at inference time and stored on the task. */
export interface GeneratedPathway {
  generated_at: string;
  goal: string;
  steps: GeneratedPathwayStep[];
  current_step_index: number;
  strict_enforcement: boolean;
}

// -- Static pathway types --

/** A named workflow sequence with per-state guidance steps. Loaded from pathways.yaml. */
export interface PathwayDefinition {
  description: string;
  initial_state: string;
  sequence: string[];
  loop?: boolean;
  guidance: Record<string, string[] | Record<string, string[]>>;
  /**
   * Display-only "ready to leave this state when..." hints, parallel to guidance.
   * Same shape: flat array for unleveled states, or {l1, l2, l3} for leveled ones.
   * Rendered under guidance; not enforced (use generated pathways for gated criteria).
   */
  exit_criteria?: Record<string, string[] | Record<string, string[]>>;
}

// -- Tool registry --

export interface CortexToolEntry {
  name: string;
  state: string;
  handle: RegisteredTool;
  /**
   * Captured at registration so the dispatcher (cortex_call / cortex_describe)
   * can reach tools that a listChanged-blind client never surfaces in
   * tools/list. Optional because the base registerTool signature does not
   * require it; the setServer interceptor fills it from def.description /
   * def.inputSchema automatically.
   */
  description?: string;
  schema?: ZodRawShape;
}

export type CortexToolRegistry = Map<string, CortexToolEntry>;
