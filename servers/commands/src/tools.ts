import os from "os";
import {
    CallToolRequestSchema,
    CallToolResult,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { verbose_log } from "./always_log.js";
import { runCommand } from "./run-command.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export function reisterTools(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        verbose_log("INFO: ListTools");
        return {
            tools: [
                {
                    name: "run_command",
                    description:
                        "Run a command on this " + os.platform() + " machine",
                    inputSchema: {
                        type: "object",
                        properties: {
                            command: {
                                type: "string",
                                description: "Command with args",
                            },
                            workdir: {
                                // previous run_command calls can probe the filesystem and find paths to change to
                                type: "string",
                                description:
                                    "Optional, current working directory",
                            },
                            stdin: {
                                type: "string",
                                description:
                                    "Optional, text to pipe into the command's STDIN. For example, pass a python script to python3. Or, pass text for a new file to the cat command to create it!",
                            },
                            timeout: {
                                type: "number",
                                description:
                                    "Optional, timeout in seconds. The command will be killed if it exceeds this duration. Use for long-running operations like ingestions or builds. No upper limit.",
                            },
                        },
                        required: ["command"],
                    },
                },
            ],
        };
    });

    server.setRequestHandler(
        CallToolRequestSchema,
        async (request): Promise<CallToolResult> => {
            verbose_log("INFO: ToolRequest", request);
            switch (request.params.name) {
                case "run_command": {
                    const progressToken = request.params._meta?.progressToken;
                    let heartbeat: ReturnType<typeof setInterval> | undefined;
                    let tick = 0;

                    if (progressToken !== undefined) {
                        heartbeat = setInterval(async () => {
                            tick++;
                            try {
                                await server.notification({
                                    method: "notifications/progress",
                                    params: {
                                        progressToken,
                                        progress: tick,
                                    },
                                });
                            } catch {
                                // client may have disconnected
                            }
                        }, 20_000);
                    }

                    try {
                        return await runCommand(request.params.arguments);
                    } finally {
                        if (heartbeat) clearInterval(heartbeat);
                    }
                }
                default:
                    throw new Error("Unknown tool");
            }
        }
    );
}
