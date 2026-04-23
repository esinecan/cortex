/**
 * Crystallization detection. Scans recently-completed tasks for repeated
 * patterns and surfaces a one-line nudge pointing at the right BRIDGES.md
 * section (bridge tool vs. static pathway). Silent unless data earns the tip.
 *
 * Symmetric to free_explore_analysis: that one nudges from escape patterns,
 * this one nudges from completion patterns.
 * @module
 */
import { createHash } from 'node:crypto';
import type { PersistentTask, TaskFinding } from './types.js';
import {
  listTasks,
  loadCrystallizeState,
  saveCrystallizeState,
  loadFreeExploreLog,
} from './storage.js';
import { getPathwayNames, getPathway } from './pathways.js';

/** How many completed tasks to look back through. */
export const WINDOW = 20;
/** A signature must recur at least this many times to produce a candidate. */
export const THRESHOLD = 3;
/** Re-suggest only once the count crosses into a new stride band. */
export const SUGGEST_STRIDE = 3;

/**
 * Hardcoded BRIDGES.md section titles. Must match the headings verbatim.
 * Renaming a heading in BRIDGES.md means updating this map -- single point
 * of coupling between code and docs.
 */
export const BRIDGES_SECTIONS = {
  'strengthen-static': 'Anything can be an MCP server',
  'promote-generated': 'Static pathways (pathways.yaml)',
  'create-static': 'Static pathways (pathways.yaml)',
} as const;

/** Per-signature-kind suggestion shape. */
export type Recommendation =
  | { kind: 'strengthen-static'; pathway: string }
  | { kind: 'promote-generated'; stepLabels: string[] }
  | { kind: 'create-static'; stateShape: string[] };

/** Evidence + tip returned by detectCandidate and crystallize_check. */
export interface CrystallizationCandidate {
  signature: string;
  count: number;
  recommendation: Recommendation;
  tip: string;
  taskIds: string[];
  /** Per-step pain point if escape data correlates strongly. null when unknown. */
  hotspot: EscapeHotspot | null;
}

/**
 * The state most commonly escaped from across a signature's task bucket.
 * `taskCount` is the number of *distinct* tasks in the bucket that escaped
 * from `state` at least once. `totalEscapes` is the sum across those tasks.
 */
export interface EscapeHotspot {
  state: string;
  taskCount: number;
  totalEscapes: number;
}

/** Minimum distinct-task count for an escape hotspot to be worth reporting. */
export const HOTSPOT_MIN_TASKS = 2;

/**
 * Collapse one task into a comparable key. Order of precedence (first match wins):
 *
 * 1. `static:<pathway>` when a static pathway is set.
 * 2. `generated:<sha1(sorted-step-labels).slice(0,12)>` when a generated pathway exists.
 *    Sorting makes the hash invariant to step reorderings.
 * 3. `states:<unique-states-arrow-joined>` ad-hoc path. Consecutive duplicates
 *    are collapsed and `base`/`free` are dropped before joining.
 * 4. `null` when none of the above produce a usable key.
 *
 * Note: state_history only fills via enter_state(task_id=...). Pathway'd tasks
 * that never had enter_state called against their id will hit rule #1 and
 * never reach rule #3. That's correct -- the pathway is the signature there.
 */
export function signature(task: PersistentTask): string | null {
  if (task.pathway) {
    return `static:${task.pathway}`;
  }

  if (task.generated_pathway) {
    const labels = task.generated_pathway.steps.map((s) => s.label).slice().sort();
    if (labels.length === 0) return null;
    const digest = createHash('sha1').update(labels.join('|')).digest('hex').slice(0, 12);
    return `generated:${digest}`;
  }

  const history = task.state_history ?? [];
  if (history.length > 0) {
    const states: string[] = [];
    for (const entry of history) {
      const s = entry.state;
      if (s === 'base' || s === 'free') continue;
      if (states[states.length - 1] === s) continue;
      states.push(s);
    }
    if (states.length === 0) return null;
    return `states:${states.join('→')}`;
  }

  return null;
}

/**
 * Pick the recommendation kind from the signature prefix and pull evidence
 * out of the matching task set. Pure -- no I/O.
 */
export function recommendFor(
  sig: string,
  exemplar: PersistentTask,
  _matches: PersistentTask[],
): Recommendation {
  if (sig.startsWith('static:')) {
    return { kind: 'strengthen-static', pathway: exemplar.pathway ?? sig.slice('static:'.length) };
  }
  if (sig.startsWith('generated:')) {
    const labels = exemplar.generated_pathway?.steps.map((s) => s.label) ?? [];
    return { kind: 'promote-generated', stepLabels: labels };
  }
  const shape = sig.slice('states:'.length).split('→');
  return { kind: 'create-static', stateShape: shape };
}

/** Map a recommendation to the BRIDGES.md heading it points at. */
export function sectionFor(rec: Recommendation): string {
  return BRIDGES_SECTIONS[rec.kind];
}

/** Pre-render the one-line tip appended to task_update responses. */
export function renderTip(
  sig: string,
  count: number,
  rec: Recommendation,
  hotspot: EscapeHotspot | null = null,
): string {
  const base =
    `Crystallization candidate: this pattern (${sig}) has run ${count} times ` +
    `in the last ${WINDOW} completed tasks.`;
  const hotspotClause = hotspot
    ? ` ${hotspot.taskCount} of these tasks escaped from "${hotspot.state}" ` +
      `(${hotspot.totalEscapes} total escapes) — that's your bridge candidate.`
    : '';
  return `${base}${hotspotClause} See BRIDGES.md → "${sectionFor(rec)}".`;
}

/**
 * Join the free_explore audit log with a bucket of tasks sharing a signature.
 * Return the `from_state` with the largest distinct-task count, provided it
 * meets HOTSPOT_MIN_TASKS. Returns null when no state clears the threshold.
 *
 * This sharpens `strengthen-static` tips: instead of "golden recurs, see
 * BRIDGES.md," we can say "3 of these 6 tasks escaped from debug — that's
 * your bridge candidate."
 *
 * `entries` is optional for test injection; omitted, the function loads the
 * full log via storage.
 */
export function correlateEscapes(
  matches: PersistentTask[],
  entries?: ReturnType<typeof loadFreeExploreLog>,
): EscapeHotspot | null {
  const log = entries ?? loadFreeExploreLog();
  const taskIds = new Set(matches.map((t) => t.id));

  // state -> { distinct task ids that escaped from it, total escapes }.
  // Each free_explore cycle writes TWO log rows (an enter marker with
  // duration_seconds=null, and an exit marker with a numeric duration).
  // Count only the enter rows so "escapes" reflects actual cycles, not entries.
  const perState = new Map<string, { tasks: Set<string>; total: number }>();
  for (const entry of log) {
    if (entry.duration_seconds !== null) continue;
    if (!entry.task_id || !taskIds.has(entry.task_id)) continue;
    const bucket = perState.get(entry.from_state) ?? { tasks: new Set(), total: 0 };
    bucket.tasks.add(entry.task_id);
    bucket.total++;
    perState.set(entry.from_state, bucket);
  }

  let best: EscapeHotspot | null = null;
  for (const [state, bucket] of perState) {
    if (bucket.tasks.size < HOTSPOT_MIN_TASKS) continue;
    if (!best || bucket.tasks.size > best.taskCount) {
      best = { state, taskCount: bucket.tasks.size, totalEscapes: bucket.total };
    }
  }
  return best;
}

/**
 * Scan recently-completed tasks and return a candidate if the just-completed
 * task pushes its signature past THRESHOLD AND we haven't already nudged for
 * that signature at this stride band. Returns null for the silent case --
 * passive A emits nothing when this is null.
 *
 * Side effect: persists the dedup counter on a positive detection.
 */
export function detectCandidate(justCompleted: PersistentTask): CrystallizationCandidate | null {
  const sig = signature(justCompleted);
  if (!sig) return null;

  const completed = listTasks()
    .filter((t) => t.status === 'completed')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const matches = completed.filter((t) => signature(t) === sig);
  if (matches.length < THRESHOLD) return null;

  const dedup = loadCrystallizeState();
  const lastSuggestedAt = dedup[sig] ?? 0;
  const band = Math.floor(matches.length / SUGGEST_STRIDE);
  const lastBand = Math.floor(lastSuggestedAt / SUGGEST_STRIDE);
  if (band <= lastBand) return null;

  dedup[sig] = matches.length;
  saveCrystallizeState(dedup);

  const recommendation = recommendFor(sig, justCompleted, matches);
  const hotspot = correlateEscapes(matches);
  return {
    signature: sig,
    count: matches.length,
    recommendation,
    tip: renderTip(sig, matches.length, recommendation, hotspot),
    taskIds: matches.map((t) => t.id),
    hotspot,
  };
}

/**
 * Collect all recurring patterns at or above THRESHOLD. Used by the active
 * crystallize_check tool -- no dedup, no side effects, always returns the
 * full picture sorted by frequency.
 */
export function collectRecurring(): Array<{
  signature: string;
  tasks: PersistentTask[];
  recommendation: Recommendation;
  hotspot: EscapeHotspot | null;
}> {
  const completed = listTasks()
    .filter((t) => t.status === 'completed')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const buckets = new Map<string, PersistentTask[]>();
  for (const t of completed) {
    const sig = signature(t);
    if (!sig) continue;
    const bucket = buckets.get(sig);
    if (bucket) bucket.push(t);
    else buckets.set(sig, [t]);
  }

  // Load the free_explore log once; share across all hotspot computations.
  const entries = loadFreeExploreLog();

  return [...buckets.entries()]
    .filter(([, ts]) => ts.length >= THRESHOLD)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([sig, tasks]) => ({
      signature: sig,
      tasks,
      recommendation: recommendFor(sig, tasks[0], tasks),
      hotspot: correlateEscapes(tasks, entries),
    }));
}

/**
 * §10.2 dead-pathway audit. For each static pathway name known to
 * `pathways.yaml`, count occurrences in the last WINDOW completed tasks.
 * Zero-use pathways are archival candidates; the sort is ascending so the
 * coldest surfaces first.
 */
export function auditPathwayUsage(): Array<{ pathway: string; uses: number }> {
  const names = getPathwayNames();
  const completed = listTasks()
    .filter((t) => t.status === 'completed')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, 0);
  for (const t of completed) {
    if (!t.pathway) continue;
    if (counts.has(t.pathway)) {
      counts.set(t.pathway, counts.get(t.pathway)! + 1);
    }
  }

  return [...counts.entries()]
    .map(([pathway, uses]) => ({ pathway, uses }))
    .sort((a, b) => a.uses - b.uses || a.pathway.localeCompare(b.pathway));
}

/**
 * §10.3 findings clustering on a signature. Load the tasks in the signature's
 * bucket (within WINDOW), collect their findings grouped by the state the
 * finding was recorded in, and lightly deduplicate entries that normalize to
 * the same prefix.
 *
 * Dedup is deliberately dumb: lowercase + whitespace-collapse + first 80 chars.
 * Good enough for a V1; bump to embedding similarity if the false-negative
 * rate becomes a problem in practice.
 */
export function digSignature(
  sig: string,
): Array<{ state: string; findings: Array<TaskFinding & { task_id: string }> }> {
  const bucket = listTasks()
    .filter((t) => t.status === 'completed' && signature(t) === sig)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const byState = new Map<string, Array<TaskFinding & { task_id: string }>>();
  const dedupKeys = new Set<string>();
  for (const t of bucket) {
    const findings = t.findings ?? [];
    for (const f of findings) {
      if (!f || typeof f.content !== 'string') continue;
      const key = normalizeForDedup(f.content);
      if (dedupKeys.has(key)) continue;
      dedupKeys.add(key);
      const group = byState.get(f.state) ?? [];
      group.push({ ...f, task_id: t.id });
      byState.set(f.state, group);
    }
  }

  return [...byState.entries()]
    .map(([state, findings]) => ({ state, findings }))
    .sort((a, b) => a.state.localeCompare(b.state));
}

function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** One row of the deviation audit, per pathway. */
export interface PathwayDeviationRow {
  pathway: string;
  /** Tasks with at least one non-base/free state in history -- the real workflow runs. */
  taskCount: number;
  /**
   * Tasks marked completed with zero non-base/free state history. These are
   * administrative closures, not real pathway runs, and are reported separately
   * so they don't inflate skip rates.
   */
  adminClosures: number;
  prescribedStates: string[];
  skippedStates: Array<{ state: string; skipCount: number; skipRate: number }>;
}

/**
 * For each pathway observed in the last WINDOW completed tasks, compare each
 * task's `state_history` against the pathway's prescribed `sequence` and count
 * prescribed states that were never visited. `base` and `free` are ignored in
 * the visited set since they're transitional/escape states.
 *
 * Tasks with empty state history are bucketed into `adminClosures` -- they
 * represent tasks closed without ever being associated to a state, not real
 * deviations. Skip rates are computed over the real-run bucket only.
 *
 * Companion to auditPathwayUsage: that one surfaces pathways with 0 uses
 * (archival candidates); this one surfaces pathways that ARE used but whose
 * prescribed states get skipped -- a pathway-design signal.
 */
export function auditPathwayDeviations(): PathwayDeviationRow[] {
  const completed = listTasks()
    .filter((t) => t.status === 'completed' && t.pathway)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const byPathway = new Map<string, typeof completed>();
  for (const t of completed) {
    if (!t.pathway) continue;
    const bucket = byPathway.get(t.pathway) ?? [];
    bucket.push(t);
    byPathway.set(t.pathway, bucket);
  }

  const rows: PathwayDeviationRow[] = [];
  for (const [pathwayName, tasks] of byPathway) {
    const pathway = getPathway(pathwayName);
    if (!pathway) continue;
    const prescribed = pathway.sequence;

    const skipCounts = new Map<string, number>();
    for (const state of prescribed) skipCounts.set(state, 0);

    let realRuns = 0;
    let adminClosures = 0;

    for (const t of tasks) {
      const visited = new Set(
        (t.state_history ?? []).map((e) => e.state).filter((s) => s !== 'base' && s !== 'free'),
      );
      if (visited.size === 0) {
        adminClosures++;
        continue;
      }
      realRuns++;
      for (const state of prescribed) {
        if (!visited.has(state)) {
          skipCounts.set(state, (skipCounts.get(state) ?? 0) + 1);
        }
      }
    }

    const skipped =
      realRuns === 0
        ? []
        : [...skipCounts.entries()]
            .filter(([, count]) => count > 0)
            .map(([state, count]) => ({
              state,
              skipCount: count,
              skipRate: count / realRuns,
            }))
            .sort((a, b) => b.skipCount - a.skipCount || a.state.localeCompare(b.state));

    rows.push({
      pathway: pathwayName,
      taskCount: realRuns,
      adminClosures,
      prescribedStates: prescribed,
      skippedStates: skipped,
    });
  }

  return rows.sort((a, b) => a.pathway.localeCompare(b.pathway));
}

/** Per-task detail row for deviation dig. */
export interface PathwayDeviationDigRow {
  taskId: string;
  title: string;
  status: string;
  updated: string;
  visitedStates: string[];
  skippedStates: string[];
  findingsTail: TaskFinding[];
}

/** How many trailing findings to include per task in the dig output. */
export const DIG_FINDINGS_TAIL = 5;

/**
 * For one pathway, return the last WINDOW completed tasks' per-task deviation
 * detail: which prescribed states they visited, which they skipped, and the
 * last N findings as context. Purpose: turn skip-rate statistics into readable
 * stories so the caller can classify cause-of-skip (pathway over-prescription
 * vs. agent discipline vs. measurement artifact).
 */
export function digPathwayDeviations(pathwayName: string): PathwayDeviationDigRow[] {
  const pathway = getPathway(pathwayName);
  if (!pathway) return [];

  const prescribed = pathway.sequence;
  const prescribedSet = new Set(prescribed);

  const completed = listTasks()
    .filter((t) => t.status === 'completed' && t.pathway === pathwayName)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  return completed.map((t) => {
    const visited = (t.state_history ?? [])
      .map((e) => e.state)
      .filter((s) => s !== 'base' && s !== 'free');
    const visitedSet = new Set(visited);

    const visitedStates = prescribed.filter((s) => visitedSet.has(s));
    const skippedStates = prescribed.filter((s) => !visitedSet.has(s));

    // Preserve the prescribed order in output, but also surface any out-of-sequence
    // visits (states that were entered but aren't in the pathway's sequence).
    const outOfSequence = visited.filter((s) => !prescribedSet.has(s));
    if (outOfSequence.length > 0) {
      visitedStates.push(...new Set(outOfSequence));
    }

    const findings = t.findings ?? [];
    const findingsTail = findings.slice(-DIG_FINDINGS_TAIL);

    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      updated: t.updated,
      visitedStates,
      skippedStates,
      findingsTail,
    };
  });
}
