import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { setTasksDir } from '../src/storage.js';
import { loadStates } from '../src/states.js';
import { StateManager } from '../src/state.js';
import { registerDispatcher } from '../src/dispatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(tmpdir(), 'cortex-test-dispatcher');

beforeAll(() => {
  loadStates(join(__dirname, '..', 'states.yaml'));
});

function makeServer(state: StateManager) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  state.setServer(server);
  return server;
}

async function callDispatcherTool(
  state: StateManager,
  name: 'cortex_call' | 'cortex_describe',
  input: Record<string, unknown>,
) {
  const entry = state.getRegistryEntry(name);
  if (!entry) throw new Error(`${name} not registered`);
  return await (entry.handle as any).handler(input, {});
}

describe('cortex dispatcher', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    setTasksDir(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // -- cortex_call --

  it('dispatches to a registered tool when in-state', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    let captured: unknown = null;
    const handle = server.registerTool(
      'demo_echo',
      { description: 'echo', inputSchema: { msg: z.string() } },
      async (args: any) => {
        captured = args.msg;
        return { content: [{ type: 'text', text: `echo:${args.msg}` }] };
      },
    );
    state.registerTool('demo_echo', 'always-on', handle);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_call', {
      tool_name: 'demo_echo',
      args: { msg: 'hi' },
    });
    expect(captured).toBe('hi');
    expect(result.content[0].text).toBe('echo:hi');
  });

  it('returns the gating hint when the inner tool is out of state', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    state.enterState('recon');
    const handle = server.registerTool('debug_only', { description: 'debug only' }, async () => ({
      content: [{ type: 'text', text: 'ran' }],
    }));
    state.registerTool('debug_only', 'debug', handle);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_call', {
      tool_name: 'debug_only',
      args: {},
    });
    const text = result.content[0].text as string;
    expect(text).toContain('gated off');
    expect(text).toContain('enter_state("debug")');
  });

  it('returns a clear error for an unknown tool name', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_call', {
      tool_name: 'no_such_tool',
      args: {},
    });
    expect(result.content[0].text).toContain('Tool not found: no_such_tool');
  });

  it('defaults args to {} when omitted', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    let receivedArgs: any = 'sentinel';
    const handle = server.registerTool(
      'demo_noarg',
      { description: 'no args' },
      async (args: any) => {
        receivedArgs = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    state.registerTool('demo_noarg', 'always-on', handle);
    registerDispatcher(server, state);

    await callDispatcherTool(state, 'cortex_call', { tool_name: 'demo_noarg' });
    expect(receivedArgs).toEqual({});
  });

  // -- cortex_describe --

  it('renders JSONSchema for a tool with input shape', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    const handle = server.registerTool(
      'demo_typed',
      {
        description: 'typed tool',
        inputSchema: { count: z.number(), label: z.string() },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    state.registerTool('demo_typed', 'always-on', handle);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_describe', {
      tool_name: 'demo_typed',
    });
    const text = result.content[0].text as string;
    expect(text).toContain('demo_typed');
    expect(text).toContain('callable now');
    expect(text).toContain('"count"');
    expect(text).toContain('"label"');
    expect(text).toContain('cortex_call({tool_name: "demo_typed"');
  });

  it('emits the no-schema fallback for a no-arg tool', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    const handle = server.registerTool('demo_noarg2', { description: 'no arg' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    state.registerTool('demo_noarg2', 'always-on', handle);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_describe', {
      tool_name: 'demo_noarg2',
    });
    const text = result.content[0].text as string;
    expect(text).toContain('takes no input arguments');
  });

  it('reports gated-off callability when state mismatches', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    state.enterState('recon');
    const handle = server.registerTool(
      'debug_describe_only',
      { description: 'd', inputSchema: { x: z.string() } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    state.registerTool('debug_describe_only', 'debug', handle);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_describe', {
      tool_name: 'debug_describe_only',
    });
    const text = result.content[0].text as string;
    expect(text).toContain('gated off in current state');
  });

  it('errors clearly when describing an unknown tool', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    registerDispatcher(server, state);

    const result = await callDispatcherTool(state, 'cortex_describe', {
      tool_name: 'ghost',
    });
    expect(result.content[0].text).toContain('Tool not found: ghost');
  });

  // -- meta capture via setServer interceptor --

  it('shallow-merges explicit meta over captured meta -- schema survives a description-only override', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    const handle = server.registerTool(
      'demo_merge',
      {
        description: 'long description from registerTool',
        inputSchema: { foo: z.string() },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    state.registerTool('demo_merge', 'always-on', handle, {
      description: 'short registry-only description',
    });

    const entry = state.getRegistryEntry('demo_merge');
    expect(entry?.description).toBe('short registry-only description');
    expect(entry?.schema).toBeDefined();
    expect(entry?.schema && Object.keys(entry.schema)).toContain('foo');
  });

  it('captures description and schema from server.registerTool without explicit meta', async () => {
    const state = new StateManager();
    const server = makeServer(state);
    const handle = server.registerTool(
      'demo_implicit_meta',
      {
        description: 'captured automatically',
        inputSchema: { tag: z.string() },
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    state.registerTool('demo_implicit_meta', 'always-on', handle);

    const entry = state.getRegistryEntry('demo_implicit_meta');
    expect(entry).toBeDefined();
    expect(entry?.description).toBe('captured automatically');
    expect(entry?.schema).toBeDefined();
    expect(entry?.schema && Object.keys(entry.schema)).toContain('tag');
  });
});
