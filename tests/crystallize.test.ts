import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTasksDir } from '../src/storage.js';
import { loadPathways } from '../src/pathways.js';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
import {
  signature,
  recommendFor,
  sectionFor,
  renderTip,
  detectCandidate,
  collectRecurring,
  correlateEscapes,
  auditPathwayUsage,
  digPathwayDeviations,
  digSignature,
  DIG_FINDINGS_TAIL,
  WINDOW,
  THRESHOLD,
  HOTSPOT_MIN_TASKS,
} from '../src/crystallize.js';
import type { PersistentTask, TaskFinding, FreeExploreEntry } from '../src/types.js';

/** Build a PersistentTask directly on disk, bypassing createTask's root limit. */
function writeTask(dir: string, partial: Partial<PersistentTask>): PersistentTask {
  const base: PersistentTask = {
    id: partial.id ?? Math.random().toString(36).slice(2, 10),
    title: partial.title ?? 'T',
    description: '',
    created: partial.created ?? new Date().toISOString(),
    updated: partial.updated ?? new Date().toISOString(),
    status: partial.status ?? 'completed',
    parent: null,
    pathway: partial.pathway ?? null,
    state_history: partial.state_history ?? [],
    findings: partial.findings ?? [],
    subtasks: [],
    generated_pathway: partial.generated_pathway,
  };
  writeFileSync(join(dir, `task-${base.id}.json`), JSON.stringify(base, null, 2));
  return base;
}

/**
 * Append a free_explore ENTER marker to the log. correlateEscapes counts
 * these (duration_seconds=null); the real state.ts emits one at enterFreeExplore
 * and a companion exit marker on exitFreeExplore. We only seed the enters here
 * because that's the event correlateEscapes is designed to count.
 */
function writeEscape(
  dir: string,
  entry: Partial<FreeExploreEntry> & { from_state: string; task_id: string },
): void {
  const full: FreeExploreEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    from_state: entry.from_state,
    reason: entry.reason ?? null,
    task_id: entry.task_id,
    duration_seconds: entry.duration_seconds ?? null,
  };
  appendFileSync(join(dir, '_free_explore_log.jsonl'), JSON.stringify(full) + '\n');
}

function finding(state: string, content: string, ts?: string): TaskFinding {
  return { state, content, ts: ts ?? new Date().toISOString() };
}

function hist(...states: string[]) {
  return states.map((s, i) => ({
    state: s,
    entered: new Date(Date.now() + i * 1000).toISOString(),
    exited: new Date(Date.now() + (i + 1) * 1000).toISOString(),
  }));
}

describe('crystallize', () => {
  let tmpDir: string;

  beforeAll(() => {
    loadPathways(join(PROJECT_ROOT, 'pathways.yaml'));
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-crystallize-'));
    setTasksDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('signature()', () => {
    it('returns static:<name> when a static pathway is set', () => {
      const t = writeTask(tmpDir, { pathway: 'golden' });
      expect(signature(t)).toBe('static:golden');
    });

    it('returns a deterministic generated: hash regardless of step order', () => {
      const makeGen = (labels: string[]): PersistentTask =>
        writeTask(tmpDir, {
          generated_pathway: {
            generated_at: new Date().toISOString(),
            goal: 'x',
            current_step_index: 0,
            strict_enforcement: false,
            steps: labels.map((l) => ({
              id: l,
              label: l,
              base_state: 'debug',
              description: '',
              acceptance_criteria: [],
              criteria_met: [],
              tools: [],
              external_guidance: { use: [], avoid: [] },
              constraints: [],
              proofs: [],
              status: 'completed' as const,
            })),
          },
        });
      const a = signature(makeGen(['Profile', 'Fix', 'Verify']));
      const b = signature(makeGen(['Verify', 'Profile', 'Fix']));
      expect(a).toBe(b);
      expect(a).toMatch(/^generated:[0-9a-f]{12}$/);
    });

    it('returns normalized state-shape ad-hoc (dedupes consecutive, drops base/free)', () => {
      const t = writeTask(tmpDir, {
        state_history: hist('base', 'recon', 'recon', 'plan', 'free', 'implement'),
      });
      expect(signature(t)).toBe('states:recon→plan→implement');
    });

    it('returns null when state_history is empty and no pathway', () => {
      const t = writeTask(tmpDir, {});
      expect(signature(t)).toBeNull();
    });

    it('tolerates legacy schema tasks missing state_history entirely', () => {
      // Pre-rename data: the field was once `mode_history`. Tasks from that
      // era live on disk without a `state_history` field at all. signature()
      // must not crash.
      const legacyRaw = {
        id: 'legacy1',
        title: 'legacy',
        description: '',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        status: 'completed',
        parent: null,
        // no pathway, no generated_pathway, no state_history
        findings: [],
        subtasks: [],
      };
      writeFileSync(join(tmpDir, `task-${legacyRaw.id}.json`), JSON.stringify(legacyRaw));
      // Read back via loader to simulate the real path. Cast: we're deliberately
      // passing a field-missing object to test defensive reads.
      expect(signature(legacyRaw as unknown as PersistentTask)).toBeNull();
    });

    it('prioritizes static pathway over state_history', () => {
      const t = writeTask(tmpDir, {
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement'),
      });
      expect(signature(t)).toBe('static:golden');
    });
  });

  describe('recommendFor() + sectionFor()', () => {
    it('maps static: -> strengthen-static / "Anything can be an MCP server"', () => {
      const t = writeTask(tmpDir, { pathway: 'golden' });
      const rec = recommendFor('static:golden', t, [t]);
      expect(rec.kind).toBe('strengthen-static');
      expect(sectionFor(rec)).toBe('Anything can be an MCP server');
    });

    it('maps generated: -> promote-generated with step labels', () => {
      const t = writeTask(tmpDir, {
        generated_pathway: {
          generated_at: '',
          goal: '',
          current_step_index: 0,
          strict_enforcement: false,
          steps: [
            {
              id: 'a',
              label: 'Profile',
              base_state: 'debug',
              description: '',
              acceptance_criteria: [],
              criteria_met: [],
              tools: [],
              external_guidance: { use: [], avoid: [] },
              constraints: [],
              proofs: [],
              status: 'completed',
            },
          ],
        },
      });
      const rec = recommendFor('generated:deadbeef', t, [t]);
      expect(rec.kind).toBe('promote-generated');
      expect(sectionFor(rec)).toBe('Static pathways (pathways.yaml)');
    });

    it('maps states: -> create-static with shape array', () => {
      const rec = recommendFor('states:recon→plan→implement', {} as PersistentTask, []);
      expect(rec.kind).toBe('create-static');
      if (rec.kind === 'create-static') {
        expect(rec.stateShape).toEqual(['recon', 'plan', 'implement']);
      }
      expect(sectionFor(rec)).toBe('Static pathways (pathways.yaml)');
    });
  });

  describe('renderTip()', () => {
    it('embeds signature, count, WINDOW, and section name', () => {
      const t = writeTask(tmpDir, { pathway: 'golden' });
      const rec = recommendFor('static:golden', t, [t]);
      const tip = renderTip('static:golden', 3, rec);
      expect(tip).toContain('(static:golden)');
      expect(tip).toContain('3 times');
      expect(tip).toContain(`last ${WINDOW}`);
      expect(tip).toContain('Anything can be an MCP server');
    });
  });

  describe('detectCandidate()', () => {
    const seedGolden = (n: number) => {
      const tasks: PersistentTask[] = [];
      for (let i = 0; i < n; i++) {
        tasks.push(
          writeTask(tmpDir, {
            id: `g${i}`,
            pathway: 'golden',
            status: 'completed',
            updated: new Date(Date.now() + i * 1000).toISOString(),
          }),
        );
      }
      return tasks;
    };

    it('returns null under threshold', () => {
      const tasks = seedGolden(THRESHOLD - 1);
      expect(detectCandidate(tasks[tasks.length - 1])).toBeNull();
    });

    it('returns candidate at exactly threshold and persists dedup', () => {
      const tasks = seedGolden(THRESHOLD);
      const c = detectCandidate(tasks[tasks.length - 1]);
      expect(c).not.toBeNull();
      expect(c!.signature).toBe('static:golden');
      expect(c!.count).toBe(THRESHOLD);
      // second call at same count band: dedup kicks in, null
      const again = detectCandidate(tasks[tasks.length - 1]);
      expect(again).toBeNull();
    });

    it('stays null when count grows within the same stride band', () => {
      // Seed incrementally so detectCandidate sees the growing count.
      const t1 = writeTask(tmpDir, { id: 'g1', pathway: 'golden', status: 'completed' });
      const t2 = writeTask(tmpDir, { id: 'g2', pathway: 'golden', status: 'completed' });
      const t3 = writeTask(tmpDir, { id: 'g3', pathway: 'golden', status: 'completed' });
      const first = detectCandidate(t3);
      expect(first).not.toBeNull();
      expect(first!.count).toBe(3);
      const t4 = writeTask(tmpDir, { id: 'g4', pathway: 'golden', status: 'completed' });
      expect(detectCandidate(t4)).toBeNull(); // count=4, same band
      void t1;
      void t2;
    });

    it('fires again when count crosses the next stride band', () => {
      const seeds: PersistentTask[] = [];
      for (let i = 0; i < 6; i++) {
        seeds.push(
          writeTask(tmpDir, {
            id: `g${i}`,
            pathway: 'golden',
            status: 'completed',
            updated: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          }),
        );
        // Call detectCandidate after each write so dedup advances incrementally.
        detectCandidate(seeds[i]);
      }
      // At i=5 (count=6) the last call should have crossed band 2.
      // Reload dedup via one more call at the same count -> should be silent now.
      expect(detectCandidate(seeds[5])).toBeNull();
      // Verify the band-crossing fired at i=5 by spot-checking the dedup
      // persisted: add a 7th task (count=7, still band 2) -- should stay null.
      const t7 = writeTask(tmpDir, {
        id: 'g6',
        pathway: 'golden',
        status: 'completed',
        updated: new Date(1_700_000_000_000 + 6_000).toISOString(),
      });
      expect(detectCandidate(t7)).toBeNull();
    });

    it('crosses stride bands across incremental completions (3 -> 6 -> 9)', () => {
      const results: Array<number | null> = [];
      for (let i = 1; i <= 9; i++) {
        const t = writeTask(tmpDir, {
          id: `g${i}`,
          pathway: 'golden',
          status: 'completed',
          updated: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        });
        const c = detectCandidate(t);
        results.push(c?.count ?? null);
      }
      // Band advances: fires at count=3 (band 1), silent 4-5, fires at 6 (band 2),
      // silent 7-8, fires at 9 (band 3).
      expect(results).toEqual([null, null, 3, null, null, 6, null, null, 9]);
    });

    it('ignores non-completed tasks', () => {
      seedGolden(2);
      writeTask(tmpDir, { id: 'active', pathway: 'golden', status: 'active' });
      writeTask(tmpDir, { id: 'abandoned', pathway: 'golden', status: 'abandoned' });
      const probe = writeTask(tmpDir, { id: 'probe', pathway: 'golden', status: 'completed' });
      expect(detectCandidate(probe)).not.toBeNull(); // 3 completed total
    });

    it('respects WINDOW (older tasks beyond limit are ignored)', () => {
      // Seed WINDOW + 5 golden tasks spaced by `updated` so the oldest 5 fall out.
      const mixed: PersistentTask[] = [];
      for (let i = 0; i < WINDOW + 5; i++) {
        mixed.push(
          writeTask(tmpDir, {
            id: `g${i}`,
            pathway: i < 5 ? 'golden' : 'investigation',
            status: 'completed',
            updated: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          }),
        );
      }
      // The 5 "golden" tasks are the oldest; newer WINDOW tasks are investigation.
      // Probe with a just-completed golden task -- but the window only holds
      // investigation tasks, so matches count stays at 1 (the probe itself is
      // not in the on-disk list until we write it).
      const probe = writeTask(tmpDir, {
        id: 'probe',
        pathway: 'golden',
        status: 'completed',
        updated: new Date(1_700_000_000_000 + (WINDOW + 10) * 1000).toISOString(),
      });
      expect(detectCandidate(probe)).toBeNull();
    });

    it('returns null for tasks with no signature', () => {
      const t = writeTask(tmpDir, {});
      expect(detectCandidate(t)).toBeNull();
    });
  });

  describe('collectRecurring()', () => {
    it('returns empty on empty store', () => {
      expect(collectRecurring()).toEqual([]);
    });

    it('groups and sorts buckets descending by count', () => {
      for (let i = 0; i < 3; i++) {
        writeTask(tmpDir, { id: `g${i}`, pathway: 'golden', status: 'completed' });
      }
      for (let i = 0; i < 5; i++) {
        writeTask(tmpDir, { id: `i${i}`, pathway: 'investigation', status: 'completed' });
      }
      const result = collectRecurring();
      expect(result.map((r) => r.signature)).toEqual(['static:investigation', 'static:golden']);
      expect(result[0].tasks.length).toBe(5);
      expect(result[1].tasks.length).toBe(3);
    });

    it('omits signatures below threshold', () => {
      writeTask(tmpDir, { id: 'a', pathway: 'golden', status: 'completed' });
      writeTask(tmpDir, { id: 'b', pathway: 'golden', status: 'completed' });
      expect(collectRecurring()).toEqual([]);
    });

    it('attaches hotspot when escape data clears the threshold', () => {
      for (let i = 0; i < 3; i++) {
        writeTask(tmpDir, { id: `g${i}`, pathway: 'golden', status: 'completed' });
      }
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'g0' });
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'g1' });
      const [row] = collectRecurring();
      expect(row.hotspot).not.toBeNull();
      expect(row.hotspot!.state).toBe('debug');
      expect(row.hotspot!.taskCount).toBe(2);
    });
  });

  describe('correlateEscapes()', () => {
    it('returns null when no escape meets HOTSPOT_MIN_TASKS', () => {
      const tasks = [writeTask(tmpDir, { id: 'a' }), writeTask(tmpDir, { id: 'b' })];
      // single-task escape below threshold
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'a' });
      expect(correlateEscapes(tasks)).toBeNull();
    });

    it('returns top state by distinct-task count, not total escapes', () => {
      const tasks = [
        writeTask(tmpDir, { id: 'a' }),
        writeTask(tmpDir, { id: 'b' }),
        writeTask(tmpDir, { id: 'c' }),
      ];
      // `debug` has 2 distinct tasks (1 escape each), `validate` has 1 task with 5 escapes.
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'a' });
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'b' });
      for (let i = 0; i < 5; i++) {
        writeEscape(tmpDir, { from_state: 'validate', task_id: 'c' });
      }
      const h = correlateEscapes(tasks);
      expect(h).not.toBeNull();
      expect(h!.state).toBe('debug');
      expect(h!.taskCount).toBe(2);
    });

    it('ignores escapes whose task_id is outside the bucket', () => {
      const tasks = [writeTask(tmpDir, { id: 'a' }), writeTask(tmpDir, { id: 'b' })];
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'z-not-in-bucket' });
      writeEscape(tmpDir, { from_state: 'debug', task_id: 'y-not-in-bucket' });
      expect(correlateEscapes(tasks)).toBeNull();
    });

    it('accepts injected entries for test isolation', () => {
      const tasks = [writeTask(tmpDir, { id: 'a' }), writeTask(tmpDir, { id: 'b' })];
      const entries: FreeExploreEntry[] = [
        {
          timestamp: '',
          from_state: 'implement',
          reason: null,
          task_id: 'a',
          duration_seconds: null,
        },
        {
          timestamp: '',
          from_state: 'implement',
          reason: null,
          task_id: 'b',
          duration_seconds: null,
        },
      ];
      const h = correlateEscapes(tasks, entries);
      expect(h?.state).toBe('implement');
    });

    it('ignores exit markers (non-null duration) to avoid double-counting cycles', () => {
      const tasks = [writeTask(tmpDir, { id: 'a' }), writeTask(tmpDir, { id: 'b' })];
      // Simulate two full enter/exit cycles across two tasks.
      const entries: FreeExploreEntry[] = [
        { timestamp: '', from_state: 'debug', reason: null, task_id: 'a', duration_seconds: null }, // enter
        { timestamp: '', from_state: 'debug', reason: null, task_id: 'a', duration_seconds: 10 }, // exit
        { timestamp: '', from_state: 'debug', reason: null, task_id: 'b', duration_seconds: null }, // enter
        { timestamp: '', from_state: 'debug', reason: null, task_id: 'b', duration_seconds: 15 }, // exit
      ];
      const h = correlateEscapes(tasks, entries);
      expect(h?.taskCount).toBe(2);
      expect(h?.totalEscapes).toBe(2); // not 4
    });

    it('HOTSPOT_MIN_TASKS is 2 (regression guard)', () => {
      expect(HOTSPOT_MIN_TASKS).toBe(2);
    });
  });

  describe('renderTip() with hotspot', () => {
    it('includes hotspot clause when hotspot is non-null', () => {
      const rec = { kind: 'strengthen-static' as const, pathway: 'golden' };
      const hotspot = { state: 'debug', taskCount: 3, totalEscapes: 5 };
      const tip = renderTip('static:golden', 6, rec, hotspot);
      expect(tip).toContain('3 of these tasks escaped from "debug"');
      expect(tip).toContain('5 total escapes');
      expect(tip).toContain('bridge candidate');
    });

    it('falls back to the base tip when hotspot is null', () => {
      const rec = { kind: 'strengthen-static' as const, pathway: 'golden' };
      const tip = renderTip('static:golden', 3, rec, null);
      expect(tip).not.toContain('bridge candidate');
      expect(tip).toContain('has run 3 times');
    });
  });

  describe('auditPathwayUsage()', () => {
    it('returns every known pathway with a count', () => {
      const rows = auditPathwayUsage();
      const names = rows.map((r) => r.pathway);
      // Generic ships golden, investigation, knowledge, code_review, free_roam, introspect.
      expect(names).toContain('golden');
      expect(names).toContain('investigation');
    });

    it('counts uses across the window', () => {
      for (let i = 0; i < 4; i++) {
        writeTask(tmpDir, { id: `g${i}`, pathway: 'golden', status: 'completed' });
      }
      const rows = auditPathwayUsage();
      const golden = rows.find((r) => r.pathway === 'golden')!;
      expect(golden.uses).toBe(4);
    });

    it('zero-use pathways sort first', () => {
      writeTask(tmpDir, { id: 'g1', pathway: 'golden', status: 'completed' });
      const rows = auditPathwayUsage();
      // The first row should have 0 uses (some pathway other than golden).
      expect(rows[0].uses).toBe(0);
      expect(rows[0].pathway).not.toBe('golden');
    });

    it('only counts completed tasks', () => {
      writeTask(tmpDir, { id: 'a', pathway: 'golden', status: 'active' });
      writeTask(tmpDir, { id: 'b', pathway: 'golden', status: 'abandoned' });
      const rows = auditPathwayUsage();
      expect(rows.find((r) => r.pathway === 'golden')!.uses).toBe(0);
    });
  });

  describe('digSignature()', () => {
    it('groups findings by state', () => {
      writeTask(tmpDir, {
        id: 'a',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('recon', 'Ticket says X'), finding('debug', 'Log shows Y')],
      });
      writeTask(tmpDir, {
        id: 'b',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('debug', 'DB missing field Z')],
      });
      const groups = digSignature('static:golden');
      const states = groups.map((g) => g.state);
      expect(states).toContain('recon');
      expect(states).toContain('debug');
      const debugGroup = groups.find((g) => g.state === 'debug')!;
      expect(debugGroup.findings).toHaveLength(2);
    });

    it('lightly dedupes near-identical findings', () => {
      writeTask(tmpDir, {
        id: 'a',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('debug', 'Rate lookup returned null')],
      });
      writeTask(tmpDir, {
        id: 'b',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('debug', 'RATE LOOKUP   returned null')], // same modulo casing/whitespace
      });
      const groups = digSignature('static:golden');
      const debugGroup = groups.find((g) => g.state === 'debug')!;
      expect(debugGroup.findings).toHaveLength(1);
    });

    it('returns empty array for unknown signature', () => {
      writeTask(tmpDir, { id: 'a', pathway: 'golden', status: 'completed' });
      expect(digSignature('static:nonexistent')).toEqual([]);
    });

    it('tags each finding with its source task id', () => {
      writeTask(tmpDir, {
        id: 'src-a',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('debug', 'A')],
      });
      writeTask(tmpDir, {
        id: 'src-b',
        pathway: 'golden',
        status: 'completed',
        findings: [finding('debug', 'B')],
      });
      const groups = digSignature('static:golden');
      const ids = groups[0].findings.map((f) => f.task_id).sort();
      expect(ids).toEqual(['src-a', 'src-b']);
    });
  });

  describe('auditPathwayDeviations()', () => {
    it('returns an empty array when no completed pathway tasks exist', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      expect(auditPathwayDeviations()).toEqual([]);
    });

    it('reports zero deviations when every prescribed state is visited', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, {
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement', 'validate', 'review'),
      });
      const rows = auditPathwayDeviations();
      expect(rows).toHaveLength(1);
      expect(rows[0].pathway).toBe('golden');
      expect(rows[0].taskCount).toBe(1);
      expect(rows[0].adminClosures).toBe(0);
      expect(rows[0].skippedStates).toEqual([]);
    });

    it('counts prescribed states that were never visited', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, {
        pathway: 'golden',
        state_history: hist('recon', 'implement'),
      });
      const rows = auditPathwayDeviations();
      const skipped = rows[0].skippedStates.map((s) => s.state).sort();
      expect(skipped).toEqual(['plan', 'review', 'validate']);
      expect(rows[0].skippedStates[0].skipCount).toBe(1);
      expect(rows[0].skippedStates[0].skipRate).toBe(1);
    });

    it('aggregates skip counts across multiple tasks of the same pathway', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, {
        id: 't1',
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement', 'validate', 'review'),
      });
      writeTask(tmpDir, {
        id: 't2',
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement', 'review'),
      });
      writeTask(tmpDir, {
        id: 't3',
        pathway: 'golden',
        state_history: hist('recon', 'implement'),
      });

      const rows = auditPathwayDeviations();
      const row = rows.find((r) => r.pathway === 'golden')!;
      const byState = new Map(row.skippedStates.map((s) => [s.state, s]));
      expect(byState.get('validate')?.skipCount).toBe(2);
      expect(byState.get('plan')?.skipCount).toBe(1);
      expect(byState.get('review')?.skipCount).toBe(1);
      expect(row.taskCount).toBe(3);
      expect(row.adminClosures).toBe(0);
    });

    it('buckets tasks with empty state history into adminClosures, not skip rates', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, {
        id: 'real',
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement', 'validate', 'review'),
      });
      writeTask(tmpDir, { id: 'admin1', pathway: 'golden', state_history: [] });
      writeTask(tmpDir, { id: 'admin2', pathway: 'golden', state_history: hist('base', 'free') });
      const row = auditPathwayDeviations().find((r) => r.pathway === 'golden')!;
      expect(row.taskCount).toBe(1);
      expect(row.adminClosures).toBe(2);
      expect(row.skippedStates).toEqual([]);
    });

    it('reports adminClosures=N and taskCount=0 when all completions are admin closures', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, { id: 'a1', pathway: 'golden', state_history: [] });
      writeTask(tmpDir, { id: 'a2', pathway: 'golden', state_history: [] });
      const row = auditPathwayDeviations().find((r) => r.pathway === 'golden')!;
      expect(row.taskCount).toBe(0);
      expect(row.adminClosures).toBe(2);
      expect(row.skippedStates).toEqual([]);
    });

    it('ignores base and free transitions in the visited set', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, {
        pathway: 'golden',
        state_history: hist('base', 'recon', 'free', 'plan', 'implement', 'validate', 'review'),
      });
      const rows = auditPathwayDeviations();
      expect(rows[0].skippedStates).toEqual([]);
    });

    it('skips tasks whose pathway name is not in pathways.yaml', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, { pathway: 'ghost', state_history: hist('recon') });
      writeTask(tmpDir, {
        pathway: 'golden',
        state_history: hist('recon', 'plan', 'implement', 'validate', 'review'),
      });
      const rows = auditPathwayDeviations();
      expect(rows.map((r) => r.pathway)).toEqual(['golden']);
    });

    it('does not double-count: a task with base+free only is an admin closure, not a deviation', async () => {
      const { auditPathwayDeviations } = await import('../src/crystallize.js');
      writeTask(tmpDir, { pathway: 'golden', state_history: hist('base', 'free', 'base') });
      const rows = auditPathwayDeviations();
      expect(rows[0].taskCount).toBe(0);
      expect(rows[0].adminClosures).toBe(1);
      expect(rows[0].skippedStates).toEqual([]);
    });
  });

  describe('digPathwayDeviations()', () => {
    it('returns empty array for an unknown pathway', () => {
      expect(digPathwayDeviations('ghost')).toEqual([]);
    });

    it('returns empty array when no completed tasks match the pathway', () => {
      writeTask(tmpDir, { pathway: 'golden', status: 'active' });
      expect(digPathwayDeviations('golden')).toEqual([]);
    });

    it('returns per-task visited and skipped states in prescribed order', () => {
      writeTask(tmpDir, {
        id: 'dig-1',
        title: 'small bug fix',
        pathway: 'investigation',
        state_history: hist('debug', 'implement'),
      });
      const rows = digPathwayDeviations('investigation');
      expect(rows).toHaveLength(1);
      expect(rows[0].taskId).toBe('dig-1');
      expect(rows[0].title).toBe('small bug fix');
      expect(rows[0].visitedStates).toEqual(['debug', 'implement']);
      expect(rows[0].skippedStates).toEqual(['validate', 'review']);
    });

    it('surfaces out-of-sequence states that were visited but not prescribed', () => {
      writeTask(tmpDir, {
        id: 'dig-oos',
        pathway: 'knowledge',
        state_history: hist('recon', 'implement'),
      });
      const rows = digPathwayDeviations('knowledge');
      expect(rows[0].visitedStates).toEqual(['recon', 'implement']);
      expect(rows[0].skippedStates).toEqual([]);
    });

    it('includes the tail of findings, bounded by DIG_FINDINGS_TAIL', () => {
      const many: TaskFinding[] = [];
      for (let i = 0; i < DIG_FINDINGS_TAIL + 3; i++) {
        many.push(finding('debug', `f${i}`, new Date(1700000000000 + i * 1000).toISOString()));
      }
      writeTask(tmpDir, {
        id: 'dig-f',
        pathway: 'investigation',
        state_history: hist('debug', 'implement', 'validate', 'review'),
        findings: many,
      });
      const rows = digPathwayDeviations('investigation');
      expect(rows[0].findingsTail).toHaveLength(DIG_FINDINGS_TAIL);
      expect(rows[0].findingsTail[0].content).toBe(`f${many.length - DIG_FINDINGS_TAIL}`);
      expect(rows[0].findingsTail.at(-1)?.content).toBe(`f${many.length - 1}`);
    });

    it('orders rows newest first by updated timestamp', () => {
      writeTask(tmpDir, { id: 'older', pathway: 'golden', updated: '2026-04-01T00:00:00Z' });
      writeTask(tmpDir, { id: 'newer', pathway: 'golden', updated: '2026-04-02T00:00:00Z' });
      const rows = digPathwayDeviations('golden');
      expect(rows.map((r) => r.taskId)).toEqual(['newer', 'older']);
    });
  });
});
