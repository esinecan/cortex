import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { reisterTools } from "../../src/tools.js";
import { registerPrompts } from "../../src/prompts.js";
import { normalizeEol } from "../helpers.js";

/**
 * End-to-end tests over a linked in-memory transport pair: a real v2 Client
 * talking to the real Server with this package's tool and prompt handlers
 * registered. This is the closest in-process approximation of what an MCP
 * client actually sees — including the fact that v2 clients strip the
 * non-spec `name` label off content blocks on the way through.
 */

describe("mcp-server-commands over in-memory transport", () => {
    let server: Server;
    let client: Client;

    beforeEach(async () => {
        server = new Server(
            { name: "mcp-server-commands-under-test", version: "0.0.0" },
            { capabilities: { tools: {}, prompts: {} } }
        );
        reisterTools(server);
        registerPrompts(server);

        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        client = new Client({ name: "test-client", version: "0.0.0" });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
    });

    afterEach(async () => {
        await client.close();
        await server.close();
    });

    describe("tools/list", () => {
        test("advertises exactly the run_command tool", async () => {
            const { tools } = await client.listTools();

            expect(tools).toHaveLength(1);
            const tool = tools[0];
            expect(tool.name).toBe("run_command");
            expect(tool.description).toContain(process.platform);
        });

        test("run_command schema requires command and offers the optional args", async () => {
            const { tools } = await client.listTools();
            const schema = tools[0].inputSchema as {
                type: string;
                properties: Record<string, unknown>;
                required: string[];
            };

            expect(schema.type).toBe("object");
            expect(schema.required).toEqual(["command"]);
            expect(Object.keys(schema.properties).sort()).toEqual([
                "command",
                "stdin",
                "timeout",
                "workdir",
            ]);
        });
    });

    describe("tools/call", () => {
        test("runs a command and returns its stdout as text content", async () => {
            const result = await client.callTool({
                name: "run_command",
                arguments: {
                    command: `node -e "console.log('over the wire')"`,
                },
            });

            expect(result.isError).toBeUndefined();
            expect(result.content).toHaveLength(1);
            const block = result.content[0] as Record<string, unknown>;
            expect(block.type).toBe("text");
            expect(normalizeEol(block.text as string)).toBe("over the wire\n");
        });

        test("passes stdin through to the command", async () => {
            const result = await client.callTool({
                name: "run_command",
                arguments: {
                    command: "node",
                    stdin: `process.stdout.write("piped in")`,
                },
            });

            expect(result.isError).toBeUndefined();
            const block = result.content[0] as Record<string, unknown>;
            expect(block.text).toBe("piped in");
        });

        test("surfaces command failure as isError with exit code first", async () => {
            const result = await client.callTool({
                name: "run_command",
                arguments: {
                    command: `node -e "process.exit(7)"`,
                },
            });

            expect(result.isError).toBe(true);
            const first = result.content[0] as Record<string, unknown>;
            expect(first.type).toBe("text");
            expect(first.text).toBe("7");
        });

        test("rejects a call without the required command argument", async () => {
            const result = await client.callTool({
                name: "run_command",
                arguments: {},
            });

            expect(result.isError).toBe(true);
            const first = result.content[0] as Record<string, unknown>;
            expect(first.text).toContain("Command is required");
        });

        test("rejects unknown tool names", async () => {
            await expect(
                client.callTool({ name: "no_such_tool", arguments: {} })
            ).rejects.toThrow();
        });
    });

    describe("prompts", () => {
        test("lists the examples and run_command prompts", async () => {
            const { prompts } = await client.listPrompts();

            expect(prompts.map((p) => p.name).sort()).toEqual([
                "examples",
                "run_command",
            ]);
        });

        test("run_command prompt executes the command and embeds its output", async () => {
            const { messages } = await client.getPrompt({
                name: "run_command",
                arguments: { command: `node -e "console.log('prompt output')"` },
            });

            expect(messages.length).toBeGreaterThanOrEqual(2);
            const texts = messages.map((m) =>
                m.content.type === "text" ? m.content.text : ""
            );
            expect(texts[0]).toContain("I ran the following command");
            expect(
                texts.some((t) => normalizeEol(t).includes("STDOUT:\nprompt output"))
            ).toBe(true);
        });

        test("unknown prompt names are rejected", async () => {
            await expect(
                client.getPrompt({ name: "nope", arguments: {} })
            ).rejects.toThrow(/Unknown or not implemented prompt/);
        });
    });
});
