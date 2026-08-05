#!/usr/bin/env node
// isession-mcp: Interactive multi-turn PTY session MCP server.
// Holds live terminal sessions (tmux-backed) and lets a driving agent send input
// and read evolving output across many model turns within one run.
//
// Transport: JSON-RPC 2.0 over stdio, newline-delimited (one JSON object per line).
// This is a dependency-free, self-contained vendored MCP server (only Node builtins + tmux).

import readline from "node:readline";
import { SessionManager } from "./session.js";

let mgr;
try {
  mgr = new SessionManager();
} catch (e) {
  process.stderr.write(`isession-mcp fatal: ${e.message}\n`);
  process.exit(1);
}

// ---- Tool schemas ----
const str = { type: "string" };
const bool = (d) => ({ type: "boolean", default: d });
const num = (d) => ({ type: "number", default: d });

const TOOLS = [
  {
    name: "isession_open",
    description:
      "Open a persistent PTY session running an interactive CLI (canonical target: pi in interactive mode). " +
      "Returns the first rendered screen, the best-guess state, and a cursor. State is held in the MCP server process for the life of the run.",
    inputSchema: {
      type: "object",
      properties: {
        command: { ...str, default: "bash", description: "program to run (e.g. 'pi')" },
        args: { type: "array", items: str, description: "program args (NOT --print for pi; use interactive mode)" },
        env: { type: "object", description: "extra env vars for the process" },
        cwd: { ...str, description: "working directory" },
        cols: num(120),
        rows: num(40),
        profile: { ...str, default: "auto", description: "prompt profile: auto|generic|pi" },
      },
    },
  },
  {
    name: "isession_send",
    description:
      "Send input to a session. submit=true appends Enter. The detector's state is a hint; the driving model is the arbiter of when pi is ready.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: str,
        input: { ...str, description: "text to type" },
        submit: bool(true),
      },
      required: ["session_id"],
    },
  },
  {
    name: "isession_read",
    description:
      "Read a session WITHOUT sending input. mode: screen (current rendered screen) | delta (new since cursor) | tail:N | full (byte-capped). Never full scrollback by default.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: str,
        mode: { ...str, default: "screen", description: "screen|delta|tail:N|full" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "isession_wait",
    description:
      "Block until a condition or timeout. until: prompt (quiescent at a prompt) | idle:Nms | pattern:<regex> | exit. Returns the screen, state, and reason.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: str,
        until: { ...str, default: "prompt", description: "prompt|idle:Nms|pattern:<rx>|exit" },
        timeout_ms: num(30000),
      },
      required: ["session_id"],
    },
  },
  {
    name: "isession_signal",
    description:
      "Send a signal or special key: INT|TERM|EOF or key:<name> (C-c, C-d, Enter, Up, Down, Escape, Tab).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: str,
        signal: { ...str, description: "INT|TERM|EOF|key:<name>" },
      },
      required: ["session_id", "signal"],
    },
  },
  {
    name: "isession_close",
    description: "Close a session, reap its process group, return final output and exit code.",
    inputSchema: {
      type: "object",
      properties: { session_id: str },
      required: ["session_id"],
    },
  },
  {
    name: "isession_list",
    description: "List live sessions.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---- dispatch ----
async function callTool(name, args) {
  args = args || {};
  mgr.reapIdle();
  let result;
  switch (name) {
    case "isession_open":
      result = mgr.open(args);
      break;
    case "isession_send":
      result = mgr.send(args.session_id, args.input, args.submit !== false);
      break;
    case "isession_read":
      result = mgr.read(args.session_id, args.mode || "screen");
      break;
    case "isession_wait":
      result = await mgr.wait(args.session_id, args.until || "prompt", args.timeout_ms ?? 30000);
      break;
    case "isession_signal":
      result = mgr.signal(args.session_id, args.signal);
      break;
    case "isession_close":
      result = mgr.close(args.session_id);
      break;
    case "isession_list":
      result = mgr.list();
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return result;
}

// ---- JSON-RPC stdio ----
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextId = 1;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg) {
  const { jsonrpc, id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "isession-mcp", version: "0.1.0" },
      },
    });
  }
  if (method === "notifications/initialized") return; // notification: no response
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await callTool(name, args);
      return send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    } catch (e) {
      return send({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: e.message },
      });
    }
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  Promise.resolve(handle(msg)).catch((e) => process.stderr.write(`handler error: ${e.stack}\n`));
});

// reap all sessions on shutdown so nothing orphans (process-group kill via tmux kill-session)
function shutdown() {
  try {
    for (const s of mgr.sessions.values()) mgr._reap(s);
    mgr.sessions.clear();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
