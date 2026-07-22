// Minimal MCP stdio client + acceptance demo for isession-mcp.
// Spawns the server ONCE and drives it through multiple tools/call round-trips,
// proving session state persists across calls (spec §9.2).
//
// Usage:
//   node drive_demo.js sanity   -> bash echo sanity (cheap plumbing test)
//   node drive_demo.js pi       -> full pi acceptance flow (multi-turn, mid-session decision)
//
// Writes transcript to the path in $TRANSCRIPT or ./transcript.txt

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "build", "index.js");

const TRANSCRIPT = process.env.TRANSCRIPT || path.join(process.cwd(), "transcript.txt");
const log = [];

function tee(line) {
  process.stdout.write(line + "\n");
  log.push(line);
}

class McpClient {
  constructor(serverPath) {
    this.proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
    this.id = 0;
    this.pending = new Map();
    let buf = "";
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this._onLine(line);
      }
    });
  }
  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async initialize() {
    const r = await this.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "drive_demo", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }
  async listTools() {
    return this.request("tools/list", {});
  }
  async call(name, args) {
    const r = await this.request("tools/call", { name, arguments: args });
    const text = r && r.content && r.content[0] && r.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  }
  close() { try { this.proc.stdin.end(); } catch {} this.proc.kill(); }
}

function trim(s, n = 60) { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "\u2026" : t; }
const BUSY = /Thinking\.\.|Working\.\.|Running|MCP:\s*connecting|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

async function sanity() {
  const c = new McpClient(SERVER);
  await c.initialize();
  const tools = await c.listTools();
  tee(`# tools/list -> ${tools.tools.length} tools`);

  const open = await c.call("isession_open", { command: "bash", args: ["--norc"], cols: 100, rows: 24 });
  const sid = open.session_id;
  tee(`# open -> session_id=${sid} state=${open.state}`);

  await c.call("isession_wait", { session_id: sid, until: "prompt", timeout_ms: 4000 });
  await c.call("isession_send", { session_id: sid, input: "echo sanity_ok_$((6*7))", submit: true });
  const w = await c.call("isession_wait", { session_id: sid, until: "prompt", timeout_ms: 4000 });
  tee(`# wait -> reason=${w.reason} state=${w.state}`);
  const r = await c.call("isession_read", { session_id: sid, mode: "screen" });
  tee("## screen " + trim(r.output, 100));
  const ok = /sanity_ok_42/.test(r.output);
  tee(`# sanity_echo_saw_42 = ${ok}`);

  const cl = await c.call("isession_close", { session_id: sid });
  tee(`# close -> exit_code=${cl.exit_code}`);
  c.close();
  return ok;
}

async function piDemo() {
  const cwd = process.env.DEMO_CWD || path.join(os.tmpdir(), "isession_demo_" + Date.now());
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  // project-local resource -> forces the interactive trust prompt on startup (a genuine
  // mid-session decision revealed only at runtime). NOT pre-approved.
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ model: "glm-5.2" }, null, 2) + "\n");
  // secret whose correct value is only revealed when pi reads it mid-session
  const SECRET = 1337;
  fs.writeFileSync(path.join(cwd, "secret.txt"), String(SECRET) + "\n");
  fs.rmSync(path.join(cwd, "result.txt"), { force: true });

  const c = new McpClient(SERVER);
  const init = await c.initialize();
  tee(`# initialize -> ${init.serverInfo.name}@${init.serverInfo.version}`);

  const env = {};
  if (process.env.ZAI_API_KEY) env.ZAI_API_KEY = process.env.ZAI_API_KEY;

  // 1) OPEN pi interactive (not --print)
  const open = await c.call("isession_open", { command: "pi", args: [], env, cwd, cols: 120, rows: 40, profile: "pi" });
  const sid = open.session_id;
  tee(`# isession_open(pi) -> session_id=${sid} state=${open.state}`);

  // 2) WAIT for prompt -> expect the TRUST menu (mid-session question #1)
  const w1 = await c.call("isession_wait", { session_id: sid, until: "prompt", timeout_ms: 25000 });
  tee(`# wait#1 -> reason=${w1.reason} state=${w1.state}`);
  const trustShown = /Trust project folder\?/.test(w1.output) || /→\s*Trust/.test(w1.output);
  tee(`# trust_prompt_shown = ${trustShown}`);
  tee("## screen@trust\n" + (w1.output || "").split("\n").filter((l) => l.trim()).slice(-8).join("\n"));

  // 3) DECISION: answer "Trust" by pressing Enter on the highlighted option
  if (trustShown) {
    await c.call("isession_signal", { session_id: sid, signal: "key:Enter" });
    tee("# driver decision: answered Trust (Enter)");
  } else {
    tee("# WARN: trust prompt not detected; proceeding");
  }

  // 4) WAIT for ready (pi boots MCP servers etc.)
  const w2 = await c.call("isession_wait", { session_id: sid, until: "pattern:MCP: \\d+/\\d+ servers", timeout_ms: 60000 });
  tee(`# wait#2 -> reason=${w2.reason} state=${w2.state}`);
  const ready = /MCP:\s*\d+\/\d+\s*servers/.test(w2.output) && /\(zai\)\s+\S+.*•\s+(low|medium|high)/.test(w2.output);
  tee(`# pi_ready = ${ready}`);

  // 5) SEND task whose artifact depends on secret revealed mid-session
  const task = "Use bash to read secret.txt, double the integer it contains, and write exactly that integer (nothing else) to result.txt. Then confirm.";
  const sent = await c.call("isession_send", { session_id: sid, input: task, submit: true });
  tee("# isession_send(task) -> state=" + sent.state);

  // 6) POLL while pi works; break when pi returns to a prompt OR the screen goes stable (idle)
  let finalState = "running";
  let stable = 0;
  let prevSig = "";
  let polls = 0;
  for (let i = 0; i < 30; i++) {
    const w = await c.call("isession_wait", { session_id: sid, until: "prompt", timeout_ms: 2000 });
    finalState = w.state;
    const busy = BUSY.test(w.output);
    const sig = w.output.replace(/\s+/g, " ").trim();
    stable = sig === prevSig ? stable + 1 : 0;
    prevSig = sig;
    polls++;
    const tailLine = (w.output || "").split("\n").filter((l) => l.trim()).slice(-1)[0];
    tee(`## poll#${i + 1} state=${w.state} busy=${busy} stable=${stable} tail=${trim(tailLine, 50)}`);
    if (fs.existsSync(path.join(cwd, "result.txt"))) { tee("## break: artifact result.txt produced"); break; }
    if (w.state === "awaiting_input" && !busy) { tee("## break: awaiting_input and not busy"); break; }
    if (/exited/.test(w.state)) break;
    if (stable >= 4) { tee("## break: whole-screen stable for 4 polls (pi idle)"); break; }
  }
  tee(`# polls=${polls}`);

  // 7) READ final screen + CLOSE
  const finalRead = await c.call("isession_read", { session_id: sid, mode: "screen" });
  tee("## final screen tail\n" + (finalRead.output || "").split("\n").filter((l) => l.trim()).slice(-10).join("\n"));
  const cl = await c.call("isession_close", { session_id: sid });
  tee(`# isession_close -> exit_code=${cl.exit_code}`);

  // 8) VERIFY artifact
  const expected = SECRET * 2;
  let artifactOk = false, artifactContent = null;
  try {
    artifactContent = fs.readFileSync(path.join(cwd, "result.txt"), "utf8").trim();
    artifactOk = String(artifactContent) === String(expected);
  } catch (e) { artifactContent = `MISSING: ${e.message}`; }

  const driverTurns = ["open", "wait#1 (see trust)", "signal Enter (trust decision)", "wait#2 (ready)", "send task", "poll loop", "close"];
  tee(`# RESULT_ARTIFACT cwd=${cwd} expected=${expected} got=${artifactContent} ok=${artifactOk}`);
  tee(`# multi_turn_driver_actions = ${driverTurns.length} (${driverTurns.join(" -> ")})`);
  const success = artifactOk && ready && trustShown && driverTurns.length >= 4;
  tee(`# SUCCESS = ${success}`);

  c.close();
  return { artifactOk, ready, trustShown, expected, got: artifactContent, cwd, success };
}

const mode = process.argv[2] || "pi";
fs.writeFileSync(TRANSCRIPT, "");
(async () => {
  let res;
  try {
    res = mode === "sanity" ? { sanity: await sanity() } : { pi: await piDemo() };
  } catch (e) {
    tee(`# FATAL ${e.stack}`);
    res = { fatal: e.message };
  }
  fs.writeFileSync(TRANSCRIPT, log.join("\n") + "\n");
  const v = Object.values(res)[0];
  const ok = v === true || (v && v.success === true);
  process.exit(ok ? 0 : 1);
})();
