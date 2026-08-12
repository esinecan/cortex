#!/usr/bin/env node
// Manual test: verify progress heartbeat notifications during long-running commands
// Usage: node tests/manual/test-heartbeat.mjs

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
    command: "node",
    args: ["build/index.js"],
});

const client = new Client({
    name: "heartbeat-test",
    version: "1.0.0",
});

await client.connect(transport);
console.log("Connected to mcp-server-commands");

const progressTicks = [];

console.log("Calling run_command with sleep 25 (should get heartbeat at ~20s)...");
const start = Date.now();

// v2: callTool takes (params, options). The v1 middle `resultSchema` argument
// was removed, so the old 3-arg form no longer applies.
const result = await client.callTool(
    { name: "run_command", arguments: { command: "sleep 25 && echo done" } },
    {
        onprogress: (progress) => {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`  [${elapsed}s] Progress notification: tick=${progress.progress}`);
            progressTicks.push(progress);
        },
        resetTimeoutOnProgress: true,
        timeout: 60_000,
    }
);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nCommand completed in ${elapsed}s`);
console.log("Result:", JSON.stringify(result, null, 2));
console.log(`\nHeartbeat notifications received: ${progressTicks.length}`);

if (progressTicks.length >= 1) {
    console.log("PASS: Heartbeat working correctly");
} else {
    console.log("FAIL: No heartbeat notifications received");
}

await client.close();
process.exit(progressTicks.length >= 1 ? 0 : 1);
