/**
 * MCP proxy infrastructure. Launches external MCP servers as child processes,
 * converts their JSON Schema tool definitions to Zod, and registers them on the
 * cortex server with state-based visibility gating.
 * @module
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from './state.js';

interface ProxiedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  toolNames: string[];
}

interface ProxyConfig {
  name: string;
  command: string;
  args: string[];
  state: string;
  curatedTools?: string[];
  env?: Record<string, string>;
}

const proxiedServers: Map<string, ProxiedServer> = new Map();

/**
 * Convert a JSON Schema property to a Zod type.
 * Handles the common types that MCP servers use.
 */
function jsonSchemaPropertyToZod(
  prop: Record<string, unknown>,
  required: boolean,
): z.ZodTypeAny {
  let zodType: z.ZodTypeAny;

  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  if (prop.enum && Array.isArray(prop.enum)) {
    const values = prop.enum as [string, ...string[]];
    zodType = z.enum(values);
  } else {
    switch (type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.preprocess(
          (val) => typeof val === 'string' ? Number(val) : val,
          z.number(),
        );
        break;
      case 'boolean':
        zodType = z.preprocess(
          (val) => typeof val === 'string' ? val === 'true' : val,
          z.boolean(),
        );
        break;
      case 'array': {
        const itemSchema = prop.items
          ? jsonSchemaPropertyToZod(prop.items as Record<string, unknown>, true)
          : z.unknown();
        zodType = z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(itemSchema),
        );
        break;
      }
      case 'object':
        zodType = z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.record(z.any()),
        );
        break;
      default:
        zodType = z.any();
    }
  }

  if (description) zodType = zodType.describe(description);
  if (!required) zodType = zodType.optional();

  return zodType;
}

/**
 * Convert a full JSON Schema inputSchema to a Zod shape for registerTool.
 */
export function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required || []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = jsonSchemaPropertyToZod(prop, required.has(key));
  }

  return shape;
}

/**
 * Launch an external MCP server, discover its tools, and register the curated
 * subset on the cortex server. Uncurated tools are registered as discoverable
 * (accessible via free explore). Retries tool discovery with backoff for servers
 * that register tools asynchronously.
 */
export async function proxyMcpServer(
  server: McpServer,
  stateManager: StateManager,
  config: ProxyConfig,
): Promise<{ total: number; curated: number }> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
  });

  const client = new Client({ name: `cortex-proxy-${config.name}`, version: '0.1.0' });
  await client.connect(transport);

  // Some servers register tools asynchronously after connect.
  // Retry listTools with backoff if we get 0 tools on first attempt.
  let remoteTools = (await client.listTools()).tools;
  if (remoteTools.length === 0) {
    for (const delay of [500, 1000, 2000]) {
      await new Promise(r => setTimeout(r, delay));
      remoteTools = (await client.listTools()).tools;
      if (remoteTools.length > 0) break;
    }
  }

  const curatedSet = config.curatedTools
    ? new Set(config.curatedTools)
    : null;

  const toolNames: string[] = [];

  for (const tool of remoteTools) {
    const toolName = tool.name;
    const isCurated = !curatedSet || curatedSet.has(toolName);
    const zodShape = jsonSchemaToZodShape(tool.inputSchema as Record<string, unknown>);
    const hasParams = Object.keys(zodShape).length > 0;

    const handle = server.registerTool(
      toolName,
      {
        description: tool.description || '',
        ...(hasParams ? { inputSchema: zodShape } : {}),
      },
      async (args: Record<string, unknown>) => {
        const loopStatus = stateManager.recordToolCall(toolName);
        const result = await client.callTool({
          name: toolName,
          arguments: args,
        });
        if (loopStatus.loopSuspected && result && typeof result === 'object' && 'content' in result) {
          const content = (result as any).content;
          if (Array.isArray(content)) {
            content.push({ type: 'text', text: `\n\n${loopStatus.warning}` });
          }
        }
        return result as any;
      },
    );

    const assignedState = isCurated ? config.state : `${config.state}:discoverable`;
    stateManager.registerTool(toolName, assignedState, handle);

    // Start disabled -- state manager will enable based on current state.
    (handle as any).enabled = false;
    toolNames.push(toolName);
  }

  proxiedServers.set(config.name, {
    name: config.name,
    client,
    transport,
    toolNames,
  });

  const curated = curatedSet ? remoteTools.filter(t => curatedSet.has(t.name)).length : remoteTools.length;
  return { total: remoteTools.length, curated };
}

export function getProxiedServer(name: string): ProxiedServer | undefined {
  return proxiedServers.get(name);
}

/** Return all proxied server entries for health checks. */
export function getAllProxiedServers(): Map<string, { name: string; toolNames: string[] }> {
  const result = new Map<string, { name: string; toolNames: string[] }>();
  for (const [name, srv] of proxiedServers) {
    result.set(name, { name: srv.name, toolNames: srv.toolNames });
  }
  return result;
}

/** Shut down all proxied servers. Called on SIGINT/SIGTERM. */
export async function disconnectAll(): Promise<void> {
  for (const [name, srv] of proxiedServers) {
    try {
      await srv.client.close();
    } catch {
      // best effort
    }
    proxiedServers.delete(name);
  }
}
