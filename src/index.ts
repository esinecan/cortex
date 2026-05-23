import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInstructions } from './instructions.js';
import { loadStates } from './states.js';
import { loadPathways } from './pathways.js';
import { StateManager } from './state.js';
import { registerAlwaysOnTools } from './tools/always-on.js';
import { registerReconTools } from './tools/recon.js';
import { registerPlanTools } from './tools/plan.js';
import { registerImplementTools } from './tools/implement.js';
import { registerDebugTools } from './tools/debug.js';
import { registerReviewTools } from './tools/review.js';
import { registerBrowseTools } from './tools/browse.js';
import { registerValidateTools } from './tools/validate.js';
import { registerCoachTools } from './tools/coach.js';
import { registerPathwayTools } from './tools/pathway.js';
import { registerThinkTools } from './tools/think.js';
import { loadMcpServers } from './config.js';
import { proxyMcpServer, disconnectAll, getAllProxiedServers } from './proxy.js';
import { registerDispatcher } from './dispatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

async function main(): Promise<void> {
  // Stage 1: Load state and pathway definitions
  loadStates(join(PROJECT_ROOT, 'states.yaml'));
  loadPathways(join(PROJECT_ROOT, 'pathways.yaml'));

  // Stage 2: Create state manager
  const state = new StateManager();

  // Stage 3: Create MCP server
  const server = new McpServer(
    { name: 'cortex', version: '0.1.0' },
    { instructions: buildInstructions() },
  );
  state.setServer(server);

  // Stage 4: Register native tools
  registerAlwaysOnTools(server, state);
  registerReconTools(server, state);
  registerPlanTools(server, state);
  registerImplementTools(server, state);
  registerDebugTools(server, state);
  registerReviewTools(server, state);
  registerBrowseTools(server, state);
  registerValidateTools(server, state);
  registerCoachTools(server, state);
  registerPathwayTools(server, state);
  registerThinkTools(server, state);

  // Stage 4b: Proxy external MCP servers
  await proxyExternalServers(server, state);

  // Stage 4c: Optional dispatcher mode for clients that ignore listChanged.
  // CORTEX_DISPATCHER_MODE=proxied:
  //   - Register cortex_call + cortex_describe (always-on umbrellas).
  //   - Disable the SDK handles for every proxied tool BEFORE server.connect,
  //     so they are born-disabled and never appear in the connect-time
  //     tools/list snapshot. This avoids the "MCP server disconnected" toast
  //     that vanishing tools trigger on clients that snapshot at connect.
  //   - Native tools stay visible so the LLM still drives the state machine.
  // Default (off): no dispatcher, no disables, byte-for-byte today's behavior.
  const dispatcherMode = process.env.CORTEX_DISPATCHER_MODE ?? 'off';
  if (dispatcherMode === 'proxied') {
    registerDispatcher(server, state);
    let suppressed = 0;
    for (const { toolNames } of getAllProxiedServers().values()) {
      for (const name of toolNames) {
        const entry = state.getRegistryEntry(name);
        if (entry) {
          entry.handle.disable();
          suppressed++;
        }
      }
    }
    process.stderr.write(
      `[cortex] Dispatcher mode: ${suppressed} proxied tools hidden behind cortex_call/cortex_describe.\n`,
    );
  }

  // Stage 5: Apply initial tool visibility based on saved state.
  // applyToolVisibility enables tools by matching: states.yaml tool list
  // (native tools) OR entry.state === currentState (proxied tools via
  // discovery_state). This means proxied tools are visible in their
  // designated state without being listed in states.yaml.
  const currentState = state.getState();
  state.enterState(
    currentState.current_state,
    currentState.active_task ?? undefined,
    currentState.current_level ?? undefined,
  );

  // Stage 6: Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const summary = state.getSessionSummary();
  if (summary) {
    process.stderr.write(`[cortex] Resuming: ${currentState.current_state}\n`);
  } else {
    process.stderr.write('[cortex] New session started in base state.\n');
  }

  process.on('SIGINT', async () => {
    await disconnectAll();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await disconnectAll();
    process.exit(0);
  });
}

async function proxyExternalServers(server: McpServer, state: StateManager): Promise<void> {
  const configs = loadMcpServers(PROJECT_ROOT);

  for (const config of configs) {
    try {
      const result = await proxyMcpServer(server, state, config);
      process.stderr.write(`[cortex] ${config.name}: ${result.curated}/${result.total} tools\n`);
    } catch (err) {
      process.stderr.write(`[cortex] ${config.name} failed (non-fatal): ${err}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[cortex] Fatal: ${err}\n`);
  process.exit(1);
});
