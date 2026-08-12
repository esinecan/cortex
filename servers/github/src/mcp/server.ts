#!/usr/bin/env node

/**
 * gh-mcp: MCP server wrapping gh CLI for read-only GitHub operations
 * 
 * Uses stdio transport for communication with MCP clients.
 */

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { TOOLS, handleToolCall } from "../tools/index.js";
import { checkGhCli } from "../core/executor.js";
import { pruneResponse } from "../core/pruner.js";
import { presentResponse } from "../core/presenters.js";

async function main() {
  // Verify gh CLI is available
  const ghCheck = await checkGhCli();
  if (!ghCheck.available) {
    console.error(`[gh-mcp] Error: ${ghCheck.error}`);
    console.error("[gh-mcp] Please install gh CLI: https://cli.github.com/");
    process.exit(1);
  }
  console.error(`[gh-mcp] Using gh CLI: ${ghCheck.version}`);

  const server = new Server(
    {
      name: "gh-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  // v2: the low-level `Server` registers spec handlers by method string.
  // The v1 zod request-schema objects (ListToolsRequestSchema etc.) are gone.
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;
    const compact = toolArgs.compact !== false; // default: true
    delete toolArgs.compact; // strip before dispatch — tools don't see it
    console.error(`[gh-mcp] Tool called: ${name} (compact: ${compact})`);

    try {
      const result = await handleToolCall(name, toolArgs);
      const presented = compact ? presentResponse(name, result, toolArgs) : result;
      const pruned = pruneResponse(presented);
      return {
        content: [{ type: "text", text: JSON.stringify(pruned, null, 2) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[gh-mcp] Error: ${errorMessage}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
        isError: true,
      };
    }
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[gh-mcp] Server running on stdio");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.error("[gh-mcp] Shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[gh-mcp] Fatal error:", error);
  process.exit(1);
});
