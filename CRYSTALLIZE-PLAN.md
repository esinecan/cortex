# Crystallization Nudge — Implementation Plan (A + B)

## Read first: which cortex are you editing?

Three sibling codebases share the same `state.ts` / `proxy.ts` / tool-module
layout. Same names, different bodies. **Editing the wrong one is the most
common foot-gun.** Match the registered MCP name, the path on disk, and the
niche before touching anything.

| MCP name (in `~/.claude.json`) | Disk path | Niche |
|---|---|---|
| `cortex-generic` | `~/hackdays/cortex` | **This repo.** Canonical, distributable, no Forto-specific deps. The upstream that the other two periodically port from. Where new mechanisms land first. |
| `cortex` | `~/dev5/cortex` | Forto/SWE flavor. Adds Datadog, MongoDB (sandbox + production), kubectl, Faro, CircleCI, Brave Search wiring; richer `debug` and `validate` states. Personal daily driver. |
| `cortex-em-pm` | `~/dev5/cortex-em-pm` | Forto EM/PM flavor. Different state machine (`pulse`, `triage`, `align`, `document`, `ship`, `broadcast`, `grow`), Google Sheets/Slack/Unleash wiring, on-enter hooks (e.g. `pulse → pulse_summary`). |

Overarching plan for cross-variant work:
1. Land the change here (`~/hackdays/cortex`, MCP name `cortex-generic`).
2. Verify via tests + mcp-inspector against the **generic** binary.
3. Port to `~/dev5/cortex` and `~/dev5/cortex-em-pm` as a near-mechanical copy
   — same `state.ts`/`proxy.ts` deltas, same wiring lines, adapt only where
   the variant adds extras (e.g. em-pm's on-enter hooks live alongside, not
   instead of, the shared logic).
4. Each variant has its own `~/.cortex/` (default) so persisted state never
   leaks between them. Don't assume one variant's tasks dir is shared.

This plan is written **for `cortex-generic`**. Path references like
`src/...`, `tests/...`, `BRIDGES.md` resolve under `~/hackdays/cortex/`.
The §8 Sequencing step is where the port-outward happens.

---

## Goal

Surface the BRIDGES.md crystallization paths (bridge tools / static pathways /
dynamic pathways) only when the data shows a real repeat pattern. Symmetric
to `free_explore_analysis`, which already nudges toward pathway crystallization
on escape patterns.

Two mechanisms, complementary:
- **A. Passive auto-detect** in `task_update` when `status` transitions to
  `completed`. Silent unless a real signal fires.
- **B. Active tool** `crystallize_check`, agent-callable, returns the same
  evidence on demand.

Ship A first. Add B only if A misses cases the human notices first.

---

## 0. Files touched

```
src/crystallize.ts          NEW   — pure detection logic + dedup state I/O
src/storage.ts              EDIT  — add load/save for _crystallize_state.json
src/tools/always-on.ts      EDIT  — wire passive nudge into task_update;
                                    register crystallize_check (B)
src/instructions.ts         EDIT  — one line under Always-On section pointing
                                    to crystallize_check (no preachy prose)
tests/crystallize.test.ts   NEW   — unit tests for signature + threshold +
                                    dedup
BRIDGES.md                  EDIT  — short "Crystallization signals" section
                                    at the bottom so the message paths render
                                    against an actual subhead
```

Total expected diff: roughly 250 LOC across new + edits.

---

## 1. Data model

### Signal sources (per task)

Available on `PersistentTask` in `src/types.ts`:
- `pathway: string | null` — static pathway name (e.g. `golden`).
- `generated_pathway.steps[].label` — semantic step names for runtime pathways.
- `state_history: StateHistoryEntry[]` — ordered list of states visited.
- `status` — only `completed` tasks count toward the signal.

### Task signature

A signature collapses one task into a comparable key:

```
signature(task: PersistentTask): string
```

Order of precedence (first match wins):
1. **Static pathway:** `static:<pathway>` if `task.pathway` is set.
2. **Generated pathway:** `generated:<sha1(sorted-step-labels).slice(0,12)>`
   if `task.generated_pathway` exists. Sorting makes the hash invariant to
   reorderings; first-12 keeps it short for logs.
3. **Ad-hoc by state shape:** `states:<unique-states-in-history-arrow-joined>`,
   e.g. `states:recon→plan→implement→validate`. Normalize: drop consecutive
   duplicates, drop `base` and `free`.
4. If none of those produce a usable key (empty state_history, no pathway):
   return `null` and skip the task entirely. No signature → not a crystallizable
   pattern.

**Subtle but load-bearing:** `state_history` only fills via
`enter_state(task_id=…)` (see `src/state.ts` `openStateHistory`). A task created
with `pathway: "golden"` that never has `enter_state` called against its id
will have an empty `state_history` and hit precedence #1 (`static:golden`),
not #3. That's correct — the pathway *is* the signature in that case. The
`states:` signature is exclusively for ad-hoc, no-pathway tasks where the
human/agent stepped through states explicitly. Don't expect it to fire on
golden-pathway runs.

### Recommendation per signature kind

```
type Recommendation =
  | { kind: 'strengthen-static'; pathway: string }   // already a static pathway
  | { kind: 'promote-generated'; stepLabels: string[] }
  | { kind: 'create-static';     stateShape: string[] };
```

- `strengthen-static`: "You've used `<pathway>` N times. If a step is repeating
  exactly, see BRIDGES.md → 'Anything can be an MCP server' to promote it to a
  bridge tool."
- `promote-generated`: "You've generated similar pathways N times. Consider
  promoting to a static pathway in `pathways.yaml`. See BRIDGES.md → 'Static
  pathways (pathways.yaml)'."
- `create-static`: "This state shape (`recon→plan→implement→validate`) repeats.
  Consider naming it as a static pathway. See BRIDGES.md → 'Static pathways
  (pathways.yaml)'."

---

## 2. Detection function

`src/crystallize.ts`:

```ts
import { createHash } from 'node:crypto';
import type { PersistentTask } from './types.js';
import {
  listTasks,
  loadCrystallizeState,
  saveCrystallizeState,
} from './storage.js';

const WINDOW = 20;        // look back at the last N completed tasks
const THRESHOLD = 3;      // signature must appear N times within window
const SUGGEST_STRIDE = 3; // re-suggest only when count grows by another stride

// Hardcoded section titles must match BRIDGES.md headings verbatim. If the
// doc is renamed, update this map. Single source of truth for the tip text.
const BRIDGES_SECTIONS = {
  'strengthen-static': 'Anything can be an MCP server',
  'promote-generated': 'Static pathways (pathways.yaml)',
  'create-static':     'Static pathways (pathways.yaml)',
} as const;

export function signature(task: PersistentTask): string | null { /* §1 */ }

/**
 * Pick the recommendation kind from the signature prefix and pull evidence
 * out of the matching task set. Pure -- no I/O.
 */
export function recommendFor(
  sig: string,
  exemplar: PersistentTask,
  matches: PersistentTask[],
): Recommendation {
  if (sig.startsWith('static:')) {
    return { kind: 'strengthen-static', pathway: exemplar.pathway! };
  }
  if (sig.startsWith('generated:')) {
    const labels = exemplar.generated_pathway?.steps.map((s) => s.label) ?? [];
    return { kind: 'promote-generated', stepLabels: labels };
  }
  // states:<arrow-joined>
  const shape = sig.slice('states:'.length).split('→');
  return { kind: 'create-static', stateShape: shape };
}

/** Map a recommendation kind to the BRIDGES.md heading it points at. */
export function sectionFor(rec: Recommendation): string {
  return BRIDGES_SECTIONS[rec.kind];
}

/** Pre-render the one-line tip appended to task_update responses. */
export function renderTip(
  sig: string,
  count: number,
  rec: Recommendation,
): string {
  return (
    `Crystallization candidate: this pattern (${sig}) has run ${count} times ` +
    `in the last ${WINDOW} completed tasks. ` +
    `See BRIDGES.md → "${sectionFor(rec)}".`
  );
}

export interface CrystallizationCandidate {
  signature: string;
  count: number;
  recommendation: Recommendation;
  tip: string;          // pre-rendered one-liner ready to append
  taskIds: string[];    // for evidence (used by B)
}

/**
 * Scan recently-completed tasks and return a candidate if the just-completed
 * task pushes its signature past the threshold AND we haven't recently nudged
 * for that signature at this count band.
 *
 * Returns null when no candidate fires — passive A is silent in that case.
 */
export function detectCandidate(justCompleted: PersistentTask): CrystallizationCandidate | null {
  const sig = signature(justCompleted);
  if (!sig) return null;

  const completed = listTasks()
    .filter(t => t.status === 'completed')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WINDOW);

  const matches = completed.filter(t => signature(t) === sig);
  if (matches.length < THRESHOLD) return null;

  const dedup = loadCrystallizeState();
  const lastSuggestedAt = dedup[sig] ?? 0;
  const band = Math.floor(matches.length / SUGGEST_STRIDE);
  if (band <= Math.floor(lastSuggestedAt / SUGGEST_STRIDE)) return null;

  dedup[sig] = matches.length;
  saveCrystallizeState(dedup);

  const recommendation = recommendFor(sig, justCompleted, matches);
  return {
    signature: sig,
    count: matches.length,
    recommendation,
    tip: renderTip(sig, matches.length, recommendation),
    taskIds: matches.map(t => t.id),
  };
}
```

The section name comes from `recommendation.kind` via `BRIDGES_SECTIONS`
(see the const above). Renaming a heading in BRIDGES.md means updating that
map -- single point of coupling.

---

## 3. Dedup state file

`~/.cortex/_crystallize_state.json` (under `getTasksDir()`):

```json
{
  "static:golden": 6,
  "states:recon→plan→implement→validate": 3
}
```

Map of signature → last-suggested count. Used to suppress repeats until the
count grows by another `SUGGEST_STRIDE`.

In `src/storage.ts`:

```ts
function crystallizeStateFile(): string {
  return join(TASKS_DIR, '_crystallize_state.json');
}

export function loadCrystallizeState(): Record<string, number> {
  ensureDir();
  const f = crystallizeStateFile();
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf-8')); }
  catch { return {}; }
}

export function saveCrystallizeState(s: Record<string, number>): void {
  ensureDir();
  writeFileSync(crystallizeStateFile(), JSON.stringify(s, null, 2));
}
```

---

## 4. Mechanism A — passive nudge in `task_update`

In `src/tools/always-on.ts` around the existing `task_update` registration
(lines 91–126):

```ts
import { detectCandidate } from '../crystallize.js';

/* inside the task_update handler, AFTER updateTask succeeds */
const t = result.task!;

let crystallizationLine = '';
if (args.status === 'completed') {
  const candidate = detectCandidate(t);
  if (candidate) crystallizationLine = `\n\n${candidate.tip}`;
}

return respond(
  state,
  `Task ${t.id} updated. Status: ${t.status}. Findings: ${t.findings.length}.${crystallizationLine}`,
  'Continue working, or `current_state` for guidance.',
);
```

Behaviour: silent on every update except completions that push a signature past
the threshold. No new prose in instructions; the line is structured and shows
up only when earned.

---

## 5. Mechanism B — active `crystallize_check` tool

Same `src/tools/always-on.ts`, alongside `free_explore_analysis`:

```ts
const crystallizeCheckHandle = server.registerTool(
  'crystallize_check',
  {
    description:
      'Inspect recent completed tasks for repeated patterns. Returns evidence ' +
      'and a recommendation when a pattern has appeared 3+ times in the last 20 ' +
      'completed tasks. Symmetric to free_explore_analysis: that one nudges from ' +
      'escape patterns; this one nudges from completion patterns.',
  },
  async () => {
    const completed = listTasks()
      .filter(t => t.status === 'completed')
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 20);

    const buckets = new Map<string, PersistentTask[]>();
    for (const t of completed) {
      const sig = signature(t);
      if (!sig) continue;
      (buckets.get(sig) ?? buckets.set(sig, []).get(sig)!).push(t);
    }

    const recurring = [...buckets.entries()]
      .filter(([, ts]) => ts.length >= 3)
      .sort((a, b) => b[1].length - a[1].length);

    if (recurring.length === 0) {
      return success('No recurring patterns yet (need 3+ completions sharing a signature).');
    }

    const lines: string[] = ['# Crystallization Candidates', ''];
    for (const [sig, ts] of recurring) {
      const rec = recommendFor(sig, ts[0], ts);
      lines.push(`## ${sig} — ${ts.length} occurrences`);
      lines.push(`Tasks: ${ts.map(t => t.id).join(', ')}`);
      lines.push(`Suggestion: ${rec.kind}`);
      lines.push(`See BRIDGES.md → "${sectionFor(rec)}"`);
      lines.push('');
    }
    return success(lines.join('\n'));
  },
);
state.registerTool('crystallize_check', 'always-on', crystallizeCheckHandle);
```

Add one line under Always-On in `src/instructions.ts`:

```
- `crystallize_check` — find repeated work that should become a bridge or pathway.
```

No marketing prose. The tool description carries the load.

---

## 6. Tests (`tests/crystallize.test.ts`)

Write these as units against the pure detection function with an in-memory
`TASKS_DIR`. Use `setTasksDir()` per test.

```
- signature(): static pathway returns "static:<name>"
- signature(): generated pathway returns deterministic hash regardless of
              step order
- signature(): ad-hoc returns normalized state-shape (no consecutive dupes,
              base/free dropped)
- signature(): empty state_history + no pathway returns null

- detectCandidate(): under threshold → null
- detectCandidate(): exactly 3 matches → returns candidate, persists dedup
- detectCandidate(): 4 matches when last-suggested=3 → null (same band)
- detectCandidate(): 6 matches when last-suggested=3 → returns again
                     (next stride band)
- detectCandidate(): only completed tasks count
- detectCandidate(): respects WINDOW (older tasks beyond 20 are ignored)

- crystallize_check tool: returns "no recurring patterns" on empty
- crystallize_check tool: groups buckets and returns sorted candidates
```

---

## 7. Manual testing via mcp-inspector — granular recipe

Throughout: use a fresh tasks dir so we don't pollute `~/.cortex`.

### 7.0 Setup

```bash
export CORTEX_TASKS_DIR=$(mktemp -d -t cortex-crystallize-XXXX)
echo "Test dir: $CORTEX_TASKS_DIR"
cd ~/hackdays/cortex && npm run build
```

### 7.1 Connect via inspector

```
mcp__mcp-inspector__insp_connect
  command: node
  args: ["/Users/eren-can.sinecan/hackdays/cortex/dist/index.js"]
  transport: stdio
  -> SAVE session_id as $S
```

(Inspector inherits the parent shell env so `CORTEX_TASKS_DIR` propagates.)

### 7.2 Mechanism A — the passive nudge

Goal: prove that `task_update` to `completed` is silent for the first two
tasks of a signature, fires on the third, then stays silent on the fourth.

```
# Seed task 1 with pathway=golden
insp_tools_call($S, task_create, {title: "T1", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id1>, status: "completed"})
  EXPECT: response text ends with "Findings: 0." and NO crystallization line.

# Task 2
insp_tools_call($S, task_create, {title: "T2", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id2>, status: "completed"})
  EXPECT: still NO crystallization line.

# Task 3 — threshold hit
insp_tools_call($S, task_create, {title: "T3", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id3>, status: "completed"})
  EXPECT: response text contains
    "Crystallization candidate: this pattern (static:golden) has run 3 times"
    "See BRIDGES.md → \"Anything can be an MCP server\""

# Task 4 — same band, must dedup
insp_tools_call($S, task_create, {title: "T4", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id4>, status: "completed"})
  EXPECT: NO crystallization line (count=4 still in stride band 1).

# Tasks 5, 6 — cross next stride
insp_tools_call($S, task_create, {title: "T5", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id5>, status: "completed"})
insp_tools_call($S, task_create, {title: "T6", pathway: "golden"})
insp_tools_call($S, task_update, {task_id: <id6>, status: "completed"})
  EXPECT on T6: crystallization line appears again with "run 6 times".

# Verify dedup file
cat $CORTEX_TASKS_DIR/_crystallize_state.json
  EXPECT: {"static:golden": 6}
```

### 7.3 Signal source coverage

Re-seed (`rm -rf $CORTEX_TASKS_DIR/*`) and verify each signature kind fires.

#### Generated-pathway path

```
insp_tools_call($S, task_create, {title: "G1", generate_pathway: true})
insp_tools_call($S, pathway_generate, {task_id: <id>, goal: "...",
  steps: [{label:"Profile", base_state:"debug", ...},
          {label:"Fix",     base_state:"implement", ...}]})
insp_tools_call($S, task_update, {task_id: <id>, status: "completed"})

# Repeat for G2, G3 with the same step labels
# EXPECT on G3: "promote-generated" recommendation in tip,
#               "See BRIDGES.md → \"Static pathways (pathways.yaml)\""
```

#### Ad-hoc state-shape path

```
# Tasks A1..A3, no pathway, but state_history walks recon→plan→implement
insp_tools_call($S, task_create, {title: "A1"})
insp_tools_call($S, enter_state, {state: "recon", task_id: <id>})
insp_tools_call($S, enter_state, {state: "plan", task_id: <id>})
insp_tools_call($S, enter_state, {state: "implement", task_id: <id>})
insp_tools_call($S, task_update, {task_id: <id>, status: "completed"})
# Repeat for A2, A3
# EXPECT on A3: "create-static" recommendation
```

### 7.4 Mechanism B — active inspection

After 7.2 ran (signature `static:golden` has 6 completions):

```
insp_tools_call($S, crystallize_check, {})
  EXPECT markdown:
    # Crystallization Candidates
    ## static:golden — 6 occurrences
    Tasks: <id6>, <id5>, <id4>, <id3>, <id2>, <id1>
    Suggestion: strengthen-static
    See BRIDGES.md → "Anything can be an MCP server"
```

Empty state:

```
rm -rf $CORTEX_TASKS_DIR/*
insp_tools_call($S, crystallize_check, {})
  EXPECT: "No recurring patterns yet (need 3+ completions sharing a signature)."
```

### 7.5 Confirm no notification storm

```
insp_read_events($S, types: ["notification"])
  EXPECT: zero events queued by any task_update or crystallize_check call.
```

(The call-gate model already guarantees this; this step is just regression
hygiene against the prior bug.)

### 7.6 Cleanup

```
insp_disconnect($S)
rm -rf "$CORTEX_TASKS_DIR"
unset CORTEX_TASKS_DIR
```

---

## 8. Sequencing and rollout

1. Write `src/crystallize.ts` + storage helpers + tests. Get unit tests green
   before touching tools.
2. Wire passive A into `task_update`. Inspector test 7.2.
3. Ship A on hackdays/cortex only. Use it for a week.
4. If the signal is helpful and dedup holds: port to `dev5/cortex` and
   `dev5/cortex-em-pm` with the same 4-line edit pattern as `think`.
5. Add B (`crystallize_check`) only if you find yourself wanting to ask the
   question proactively. Same per-variant port path when added.

---

## 9. Anti-goals (what this is not)

- **Not a tip-on-every-completion.** The whole point is data-triggered silence
  by default.
- **Not a generator.** It points at BRIDGES.md and names the section. It does
  not draft `pathways.yaml` entries or scaffold MCP servers. That's a separate
  follow-up if A+B prove valuable.
- **Not parroted into user-facing summaries.** The tip is structured text with
  a section pointer; the agent should not re-explain it. If parroting becomes
  a problem, add a one-liner to the instructions: "Pass crystallization tips
  through verbatim, do not paraphrase."
- **Not a cross-variant shared store.** Each cortex variant has its own
  `_crystallize_state.json` under its own `TASKS_DIR`. Patterns are local to
  the variant the work was done in.

---

## 10. Follow-up patches (planned, not yet implemented)

Core A+B shipped and verified end-to-end (generic + dev5/cortex). The feature
works but three sharpening patches are worth landing before (or alongside) the
push. Ordered by value per LOC. Each is additive, none mutate existing
behavior, all ride the same 6-file port pattern when moving generic -> dev5.

### 10.1 Per-step escape correlation (sharpens `strengthen-static`)

**Problem.** Today's `strengthen-static` tip says: "pattern (static:golden) has
run N times. See BRIDGES.md -> Anything can be an MCP server." Which step of
golden is the pain point? Unanswered. The tip is directionally right but
operationally vague.

**Fix.** Join the free_explore log with the signature's matched task set. For
each task in the bucket, count escapes per `from_state`. Surface the top-1
state as the concrete bridge candidate.

**Tip delta.**
Before: `See BRIDGES.md -> "Anything can be an MCP server"`
After:  `6 of these tasks escaped from "debug" -- that's your bridge candidate. See BRIDGES.md -> "Anything can be an MCP server"`

**Files.**
- `src/crystallize.ts` -- add `correlateEscapes(matches: PersistentTask[]): { state: string, escapes: number } | null`.
  Loads `loadFreeExploreLog()`, filters by `task_id in matches`, groups by
  `from_state`, returns the top bucket if >= 2 escapes. Threshold-2 so a
  single escape doesn't fire the sharper tip.
- `src/crystallize.ts` -- extend `renderTip` to accept an optional hotspot
  and prepend the "N of these tasks escaped from X" sentence.
- No schema changes. No storage changes.

**Fallback.** If no escapes exist in the bucket, current tip renders
unchanged. Null-safe.

**Tests (unit, tmp tasks dir).**
- correlateEscapes: returns top state when >=2 escapes present
- correlateEscapes: returns null when <2 escapes in bucket
- correlateEscapes: ignores escapes whose task_id is outside the bucket
- renderTip: appends hotspot clause when hotspot is non-null
- renderTip: unchanged output when hotspot is null

**Size.** ~40 LOC + 5 tests. Port to dev5: same file edits, mechanical.

**Disconfirmation to check during implementation.** Is `task_id` reliably
populated on FreeExploreEntry? Quick read confirms yes (`state.ts`
enterFreeExplore passes `this.state.active_task`). Safe.

---

### 10.2 Dead pathway audit (mirror of crystallization)

**Problem.** Crystallization surfaces what should become a pathway. The
mirror -- pathways that stopped being used -- has no detector. `pathways.yaml`
accumulates experiments; `suggest_state`'s keyword table suggests dead
pathways alongside live ones. Clutter compounds.

**Fix.** New always-on read-only tool `pathway_usage_audit`. Walks
`pathways.yaml` names, counts occurrences in last-WINDOW completed tasks,
returns the list sorted ascending (coldest first). Pathways with zero uses
in WINDOW are flagged as archival candidates.

**Output shape.**
```
# Pathway Usage (last 20 completed)
- `hotfix` -- 0 uses (archival candidate)
- `data_migration` -- 1 use
- `knowledge` -- 4 uses
- `golden` -- 9 uses
```

**Files.**
- `src/crystallize.ts` -- add `auditPathwayUsage(): Array<{pathway, uses}>`
  using existing listTasks + WINDOW slice.
- `src/tools/always-on.ts` -- register `pathway_usage_audit` next to
  `crystallize_check`.
- `src/instructions.ts` -- one-liner under Always-On.
- Uses existing `getPathwayNames()` from `pathways.ts`.

**Tests.**
- auditPathwayUsage: returns all known pathways with counts
- auditPathwayUsage: zero-use pathways sort first
- tool output: formatted markdown, archival tag on zero-use

**Size.** ~30 LOC + 4 tests. Smallest of the three.

**Deliberate scope cut.** No auto-remove, no "archive this pathway" tool.
Pathways.yaml is human-curated; the signal is enough.

---

### 10.3 Findings clustering on signature (`crystallize_check` dig mode)

**Problem.** `crystallize_check` lists task ids for a recurring signature.
The useful question is "what do these 6 tasks have in common, in their own
words?" The findings across the bucket probably cluster around the same pain
points. Currently you have to `task_context` each one by hand.

**Fix.** Add optional `signature` param to `crystallize_check`. When
provided, return cross-task findings for that bucket, grouped by state,
lightly deduplicated.

**Deduplication strategy.** Start dumb: normalize whitespace, lowercase,
hash first 80 chars; treat as duplicate if hash matches. No embeddings yet.
Good-enough for a V1; add cosine later if false-negatives pile up.

**Output shape.**
```
# Signature: static:golden (6 occurrences)
## debug (3 unique findings across tasks)
- [g1] "Couldn't find MongoDB connection string in env"
- [g3] "TMS token expired mid-investigation"
- [g5] "No log for shipment state transition"
## validate (2 unique findings)
- [g2] "E2E flow hangs at Accept step"
- [g4] "Flaky unit tests block validate_advance"
```

**Files.**
- `src/crystallize.ts` -- add `digSignature(sig: string): Array<{state, findings: TaskFinding[]}>`.
- `src/tools/always-on.ts` -- add `signature` param to `crystallize_check`
  input schema; branch handler: if provided, call `digSignature`; else
  current behavior.

**Tests.**
- digSignature: groups findings by state
- digSignature: dedupes near-duplicate findings
- digSignature: returns empty for unknown signature
- tool: default call unchanged (no param)
- tool: dig call returns grouped output

**Size.** ~60 LOC + 5 tests. Largest of the three.

**Deliberate scope cut.** No clustering across signatures. No LLM
summarization. No export. Signal first, synthesis later.

---

### 10.4 Explicitly deferred

- **Promote-to-pathway generator** (idea #1 from the tooling brainstorm).
  Breaks the §9 anti-goal ("not a generator, does not draft pathways.yaml
  entries"). Revisit after two or more `promote-generated` tips have
  actually surfaced in live use -- at that point the anti-goal is an
  artifact of pre-data caution rather than a real boundary.
- **Recon-time priors surfacing** (idea #4). Intrusive: touches state
  guidance, not crystallize machinery. Belongs in a separate task on the
  recon/state-guidance surface, not this feature's patch series.
- **Meta-signature (dogfooding our own shipping pathway as generated)**
  (idea #5). Not code. Note in MEMORY if worth preserving; otherwise noop.

---

### 10.5 Sequencing

1. Land 10.1 in `~/hackdays/cortex`. Unit tests. Inspector spot-check the
   new tip text under a seeded escape log.
2. Port 10.1 to `~/dev5/cortex` (6-file pattern). Build + tests.
3. Repeat for 10.2, then 10.3.
4. Push all three (plus core A+B) together. Three tight commits are fine,
   one rollup is fine -- reviewer's call.

Each of the three is independent: if 10.3 gets stuck, 10.1 and 10.2 ship
without it. No ordering constraint beyond "easier first for momentum."

---

### 10.6 Quality axis on task resolution (separate task, flagged here)

**Problem.** `status=completed` is a blanket. It covers tasks that ran
clean, tasks that got there after repeated corrections, and tasks that
barely finished. Crystallization treats all three the same, so a pathway
that recurs *because it keeps going wrong* reads identically to a pathway
that recurs *because it works*. That inverts what the tip should say:
heavy-correction recurrence is the loud signal, clean recurrence is fine
as-is.

**Honest observation about data.** In practice, a meaningful fraction of
"completed" tasks reach that state through user-driven mid-course
corrections. Every correction is a data point; currently all of it gets
collapsed into a single success state.

**Two complementary fixes, both deferred from this push:**

1. **Status split.** Extend `TaskStatus` from
   `'active' | 'paused' | 'blocked' | 'completed' | 'abandoned'` to
   include `'succeeded'` and `'failed'` as distinct terminal states.
   `completed` either becomes an umbrella that requires a sub-choice, or
   is sunset in favor of the sharper pair. Breaking change; touches every
   consumer of status. Worth its own ticket.
2. **Auto-derived quality score.** Computed at completion time from data
   already on the task: finding density, free_explore escape count, loop
   warnings emitted, state re-entry count (plan -> implement -> plan is
   a loop, not a clean run), tool call volume. No new storage, no user
   input. Low fidelity but zero friction. Use this as the filter knob in
   crystallization until #1 lands.

**Effect on crystallization tips:**
- `strengthen-static` should only fire when *high-correction recurrence*
  crosses threshold. Clean recurrence = no tip (pathway is working).
- `promote-generated` likewise: only promote a generated pathway that
  consistently succeeds; don't enshrine a template that needs rescuing
  every time.
- `create-static` is the outlier — ad-hoc state walks that recur at all
  are worth naming, regardless of quality.

**Why deferred.** Status split is an enum change that ripples through
tests, schemas, and dashboard code in all three variants. Auto-derived
score is smaller but still a crystallize.ts diff plus threshold tuning
based on real data. Both are more defensible with a week of live A+B
data showing which pathways actually recur under load.

**Write-down reason.** Without this note the ship bias is to leave
`completed` as-is and keep optimizing for recurrence. The correction is
"recurrence-with-quality," and it's easier to get right on paper now
than to retrofit after the tips have shaped behavior.

**Migration of existing `completed` tasks.** Three paths, pick one when
this lands:

1. **Blind success backfill.** Mark all existing `completed` as
   `succeeded`. Simplest. Preserves tip continuity through the
   migration. Defensible because most historical completions did in
   fact succeed (noisy but majority-right). Downside: known-rough tasks
   get labeled as clean, biasing the filter toward "recurrence is
   healthy" for a window.
2. **Lazy aging.** No migration. Old tasks keep `completed`, treated as
   unknown-quality by the crystallization filter. Within ~20 new
   resolutions (WINDOW), detector operates entirely on labeled data.
   Downside: ~20-completion dead period where tips go quiet.
3. **Heuristic backfill.** One-pass script: default to `succeeded`,
   downgrade if the task has high finding density, loop-warning
   findings, or late-added `[correction]`-flavored notes. Best
   fidelity, most code. Preserves tip continuity without blindly
   mislabeling rough tasks.

Default pick: #1 unless live data shows tip quality suffering, in which
case upgrade to #3. #2 is the "I don't trust my own heuristics" option
and is fine as a fallback.
