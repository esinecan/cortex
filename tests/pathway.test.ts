import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { setTasksDir, loadTask } from '../src/storage.js';
import { loadStates } from '../src/states.js';
import { StateManager } from '../src/state.js';
import { createTask } from '../src/tasks.js';
import { registerPathwayTools } from '../src/tools/pathway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function call(state: StateManager, name: string, input: Record<string, unknown>) {
  const entry = state.getRegistryEntry(name);
  if (!entry) throw new Error(`${name} not registered`);
  return await (entry.handle as any).handler(input, {});
}

const step = (label: string) => ({
  label,
  base_state: 'recon',
  description: 'd',
  acceptance_criteria: ['c'],
  tools: [],
  external_guidance: { use: [], avoid: [] },
  constraints: [],
});

describe('pathway_reset', () => {
  let tmpDir: string;

  beforeAll(() => {
    loadStates(join(__dirname, '..', 'states.yaml'));
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-test-pathway-'));
    setTasksDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets pathway_generate run again after a reset', async () => {
    const state = new StateManager();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    state.setServer(server);
    registerPathwayTools(server, state);
    const id = createTask('t', 'd').task!.id;

    const first = await call(state, 'pathway_generate', { task_id: id, goal: 'g1', steps: [step('a')], strict: true });
    expect(first.isError).toBeFalsy();
    const refused = await call(state, 'pathway_generate', { task_id: id, goal: 'g2', steps: [step('b')], strict: true });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('pathway_reset');

    const reset = await call(state, 'pathway_reset', { task_id: id, reason: 'replace' });
    expect(reset.isError).toBeFalsy();
    expect(loadTask(id)!.generated_pathway).toBeUndefined();
    expect(loadTask(id)!.findings.some((f) => f.content.startsWith('[pathway:reset] "g1"'))).toBe(true);

    const again = await call(state, 'pathway_generate', { task_id: id, goal: 'g2', steps: [step('b')], strict: true });
    expect(again.isError).toBeFalsy();
    expect(loadTask(id)!.generated_pathway!.goal).toBe('g2');
  });

  it('refuses a task without a generated pathway', async () => {
    const state = new StateManager();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    state.setServer(server);
    registerPathwayTools(server, state);
    const id = createTask('t', 'd').task!.id;
    const res = await call(state, 'pathway_reset', { task_id: id, reason: 'none' });
    expect(res.isError).toBe(true);
  });
});
