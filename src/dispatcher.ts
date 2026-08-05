/**
 * Side-channel dispatcher for clients that snapshot tools/list at connect and
 * ignore notifications/tools/list_changed. Two umbrella tools, cortex_call
 * and cortex_describe, read cortex's in-process registry and reach any
 * registered tool, including tools that were born-disabled before the
 * connect-time snapshot.
 *
 * Design notes:
 *  - cortex_call RESPECTS the call-time gate (state + pathway). Cortex's
 *    gating is semantic, not cosmetic, so out-of-state invocations produce
 *    the same hint a direct call would.
 *  - cortex_discover already covers state-grouped listing and dynamic enable
 *    in free explore, so the dispatcher does not add a third list_available
 *    tool.
 *  - Schema rendering uses the Zod shape captured at registration time by
 *    the StateManager.setServer interceptor.
 * @module
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from './state.js';

export function registerDispatcher(server: McpServer, state: StateManager): void {
  // -- cortex_call -----------------------------------------------------
  const callHandle = server.registerTool(
    'cortex_call',
    {
      description: [
        "Dispatch any cortex tool by name through cortex's in-process registry.",
        '',
        'Cortex is a state machine. At any moment only a subset of its tools is',
        'callable, gated by current state + active pathway step. cortex_call',
        'respects that gate; out-of-state invocations return the same hint a direct',
        'call would. Use it for state transitions too:',
        'cortex_call({tool_name: "enter_state", args: {state: "debug"}}).',
        '',
        'Three-step workflow:',
        '  cortex_discover({query})  -> find tool names',
        '  cortex_describe({name})   -> see input schema + callability',
        '  cortex_call({name, args}) -> invoke',
        '',
        'Cold start? Dispatch task_list, then current_state. Tasks persist across',
        'sessions and current_state shows the active pathway step.',
        '',
        'This exists because some clients ignore tools/list_changed, so under',
        'CORTEX_DISPATCHER_MODE=proxied the proxied tools are hidden from tools/list.',
        "They're still registered server-side; cortex_call reaches them.",
      ].join(' '),
      inputSchema: {
        tool_name: z.string().describe('Exact registered tool name. Names are case-sensitive.'),
        args: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.record(z.unknown()).optional(),
          )
          .describe('Arguments to pass to the tool. Defaults to {} if omitted.'),
      },
    },
    async (input) => {
      const { tool_name, args } = input;
      const entry = state.getRegistryEntry(tool_name);
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool not found: ${tool_name}. Use cortex_discover to search registered names. Names are case-sensitive.`,
            },
          ],
        };
      }
      const handler = (entry.handle as any).handler;
      if (typeof handler !== 'function') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool ${tool_name} is registered but has no callable handler.`,
            },
          ],
        };
      }
      const result = await handler(args ?? {}, {});
      return result as any;
    },
  );
  // No explicit meta: the setServer interceptor already captured the rich
  // description and the input schema from server.registerTool above. Passing
  // explicit meta here would override the rich description with a shorter
  // one, which cortex_describe would then surface (regression).
  state.registerTool('cortex_call', 'always-on', callHandle);

  // -- cortex_describe -------------------------------------------------
  const describeHandle = server.registerTool(
    'cortex_describe',
    {
      description: [
        'Return input JSONSchema, description, state, and current callability for',
        'any registered cortex tool. Call this BEFORE cortex_call when the input',
        'shape is unknown, or to check whether a tool is callable now vs gated off.',
        'Output ends with an example cortex_call invocation.',
        '',
        'Workflow: cortex_discover (find name) -> cortex_describe (this) -> cortex_call.',
      ].join(' '),
      inputSchema: {
        tool_name: z.string().describe('Exact registered tool name.'),
      },
    },
    async (input) => {
      const { tool_name } = input;
      const entry = state.getRegistryEntry(tool_name);
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool not found: ${tool_name}. Use cortex_discover to search.`,
            },
          ],
        };
      }
      const allowed = state.isToolAllowed(tool_name);
      const callability = allowed ? 'callable now' : 'gated off in current state';
      let schemaBlock: string;
      if (entry.schema && Object.keys(entry.schema).length > 0) {
        const json = zodToJsonSchema(z.object(entry.schema), { target: 'jsonSchema7' });
        schemaBlock = '```json\n' + JSON.stringify(json, null, 2) + '\n```';
      } else {
        schemaBlock =
          '> This tool takes no input arguments. Invoke with `args: {}` (or omit args entirely).';
      }
      const lines = [
        `## ${entry.name}`,
        `**State:** \`${entry.state}\` -- ${callability}`,
        '',
        '### Description',
        entry.description || '(none captured)',
        '',
        '### Input JSONSchema',
        schemaBlock,
        '',
        `> Invoke with: \`cortex_call({tool_name: "${entry.name}", args: { ... }})\``,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
  state.registerTool('cortex_describe', 'always-on', describeHandle);
}
