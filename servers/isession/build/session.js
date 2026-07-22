// Session manager. tmux-backed PTY + vt100 rendering.
// Each session = one detached tmux session (gives process-group isolation + group-kill on reap
// for free, reusing the pi-runner setsid/group-kill discipline).
// State held in-process, keyed by session_id, for the life of the MCP server run.

import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { classify } from "./detect.js";
import { getProfile, profileForCommand } from "./profiles.js";

const MAX_SESSIONS = 8;
const IDLE_CEILING_MS = 10 * 60 * 1000; // reap session after this much inactivity
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const POLL_MS = 150;
const QUIESCE_MS = 500; // default "no new bytes" window

function tmux(args) {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tmuxOk() {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function q(arg) {
  // quote a single arg for /bin/sh -c payload, wrapping in double quotes
  return '"' + String(arg).replace(/(["\\$`])/g, "\\$1") + '"';
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    if (!tmuxOk()) throw new Error("tmux not found on PATH; install tmux to use isession_*");
    this._sweepOrphans();
  }

  // Reap any isess_* tmux sessions left behind by a previously hard-killed server,
  // so nothing orphans (spec §7 lifecycle/safety).
  _sweepOrphans() {
    let list = [];
    try { list = tmux(["list-sessions", "-F", "#{session_name}"]).split("\n").map((s) => s.trim()).filter(Boolean); }
    catch { return; }
    for (const name of list) {
      if (name.startsWith("isess_")) {
        try { tmux(["kill-session", "-t", name]); } catch {}
      }
    }
  }

  _s(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session_id: ${id}`);
    return s;
  }

  open({ command = "bash", args = [], env = {}, cwd, cols = 120, rows = 40, profile = "auto" } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`max concurrent sessions (${MAX_SESSIONS}) reached`);

    const id = "isess_" + randomUUID().slice(0, 8);
    const prof = profile === "auto" ? profileForCommand(command) : getProfile(profile);

    // login shell wrapping the target so rc/keys load (the ZAI_API_KEY login-shell rule),
    // and the target is exec'd inheriting the login env + any -e env overrides.
    const target = [command, ...(args || [])].map(q).join(" ");
    const shellCmd = `bash -lc 'exec "$@"' _ ${target}`;
    const envArgs = [];
    for (const [k, v] of Object.entries(env || {})) envArgs.push("-e", `${k}=${v}`);

    tmux([
      "new-session", "-d", "-s", id,
      "-x", String(cols), "-y", String(rows),
      ...envArgs,
      "-c", cwd || process.env.HOME || "/tmp",
      shellCmd,
    ]);

    this.sessions.set(id, {
      session_id: id,
      tmux: id,
      command: String(command),
      args: args || [],
      cwd: cwd || null,
      profile: prof.name,
      cols, rows,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastChange: Date.now(),
      lastScreen: [],
      buffer: [],          // growing stitched log of rendered lines (deduped redraws)
      delivered: 0,        // cursor: buffer lines already returned via delta
      lastState: "running",
    });
    const first = this.read(id, "screen");
    return { session_id: id, ...first };
  }

  _captureRaw(name) {
    try {
      const out = tmux(["capture-pane", "-p", "-t", name, "-S", "-", "-E", "-"]);
      return out.replace(/\n+$/, "").split("\n");
    } catch {
      return [];
    }
  }

  _dead(s) {
    try {
      const d = tmux(["list-panes", "-t", s.tmux, "-F", "#{pane_dead}"]).trim();
      return d === "1";
    } catch {
      return true; // session gone
    }
  }

  _exitCode(s) {
    try {
      const code = tmux(["list-panes", "-t", s.tmux, "-F", "#{pane_dead_status}"]).trim();
      if (code === "" || code == null) return null;
      return Number(code);
    } catch {
      return null;
    }
  }

  // Update stitched buffer from a fresh capture; dedupe identical redraws; append new tail.
  _update(s) {
    const cur = this._captureRaw(s.tmux);
    const now = Date.now();
    s.lastActivity = now;
    const curJoin = cur.join("\n");
    if (curJoin !== (s.lastScreen || []).join("\n")) {
      s.lastChange = now;
      let newLines = [];
      const prev = s.lastScreen || [];
      if (prev.length) {
        const anchor = (prev[prev.length - 1] || "").trim();
        let idx = -1;
        if (anchor !== "") {
          for (let i = cur.length - 1; i >= 0; i--) {
            if ((cur[i] || "").trim() === anchor) { idx = i; break; }
          }
        }
        newLines = idx >= 0 ? cur.slice(idx + 1) : cur.slice(Math.max(0, cur.length - prev.length));
      } else {
        newLines = cur.slice();
      }
      for (const l of newLines) s.buffer.push(l);
      // enforce byte cap (drop from head)
      let bytes = s.buffer.join("\n").length;
      while (bytes > MAX_BUFFER_BYTES && s.buffer.length > 1) {
        const dropped = s.buffer.shift();
        s.delivered = Math.max(0, s.delivered - 1);
        bytes -= (dropped.length + 1);
      }
    }
    s.lastScreen = cur;
    s.lastState = classify(cur, getProfile(s.profile), now - s.lastChange > QUIESCE_MS).state;
    return s;
  }

  read(id, mode = "screen") {
    const s = this._s(id);
    this._update(s);
    let output;
    if (mode === "screen") {
      output = s.lastScreen.join("\n");
    } else if (mode === "delta") {
      output = s.buffer.slice(s.delivered).join("\n");
      s.delivered = s.buffer.length;
    } else if (mode.startsWith("tail:")) {
      const n = Math.max(1, parseInt(mode.split(":")[1], 10) || 50);
      output = s.buffer.slice(-n).join("\n");
    } else if (mode === "full") {
      output = s.buffer.join("\n");
      if (output.length > MAX_BUFFER_BYTES) output = output.slice(-MAX_BUFFER_BYTES);
    } else {
      output = s.lastScreen.join("\n");
    }
    const idle = Date.now() - s.lastChange > QUIESCE_MS;
    const c = classify(s.lastScreen, getProfile(s.profile), idle);
    s.lastState = this._dead(s) ? "exited" : c.state;
    return { output, state: s.lastState, cursor: s.buffer.length };
  }

  send(id, input, submit = true) {
    const s = this._s(id);
    if (this._dead(s)) throw new Error("session process has exited");
    if (input != null && input !== "") {
      tmux(["send-keys", "-t", s.tmux, "-l", String(input)]);
    }
    if (submit) tmux(["send-keys", "-t", s.tmux, "Enter"]);
    s.lastActivity = Date.now();
    return this.read(id, "screen");
  }

  async wait(id, until = "prompt", timeout_ms = 30000) {
    const s = this._s(id);
    const prof = getProfile(s.profile);
    const start = Date.now();
    let reason = "timeout";
    let verdict = "running";

    let idleWindow = QUIESCE_MS;
    if (until.startsWith("idle:")) idleWindow = Math.max(50, parseInt(until.split(":")[1], 10) || QUIESCE_MS);

    while (Date.now() - start < (timeout_ms || 0)) {
      this._update(s);
      const idle = Date.now() - s.lastChange > idleWindow;
      const dead = this._dead(s);
      const c = classify(s.lastScreen, prof, idle);
      verdict = dead ? "exited" : c.state;
      s.lastState = verdict;

      if (dead) { reason = "exited"; break; }
      if (until === "prompt" && c.state === "awaiting_input") { reason = c.reason; break; }
      if (until.startsWith("idle:") && idle) { reason = "idle"; break; }
      if (until.startsWith("pattern:")) {
        const rx = new RegExp(until.slice("pattern:".length));
        if (rx.test(s.lastScreen.join("\n"))) { reason = "pattern"; verdict = c.state; break; }
      }
      if (until === "exit") { /* loop until dead or timeout */ }
      await sleep(POLL_MS);
    }

    if (reason === "timeout") {
      const dead = this._dead(s);
      if (dead) { reason = "exited"; verdict = "exited"; }
    }
    return { output: s.lastScreen.join("\n"), state: verdict, reason };
  }

  signal(id, signal) {
    const s = this._s(id);
    const sig = String(signal || "").trim();
    let keys = [];
    if (sig === "INT" || sig === "key:C-c" || sig === "C-c") keys = ["C-c"];
    else if (sig === "EOF" || sig === "key:C-d" || sig === "C-d") keys = ["C-d"];
    else if (sig === "TERM") {
      try { tmux(["send-keys", "-t", s.tmux, "C-c"]); } catch {}
      this._reap(s);
      return { output: s.lastScreen.join("\n"), state: "exited" };
    } else if (sig.startsWith("key:")) keys = [sig.slice(4)];
    else if (sig === "Enter" || sig === "Up" || sig === "Down" || sig === "Escape" || sig === "Tab" || sig === "Space") keys = [sig];
    else throw new Error(`unknown signal: ${sig}`);

    if (keys.length && !this._dead(s)) {
      tmux(["send-keys", "-t", s.tmux, ...keys]);
    }
    s.lastActivity = Date.now();
    return this.read(id, "screen");
  }

  _reap(s) {
    try { tmux(["kill-session", "-t", s.tmux]); } catch {}
  }

  close(id) {
    const s = this._s(id);
    this._update(s);
    const final_output = s.lastScreen.join("\n");
    const wasDead = this._dead(s);
    const exit_code = wasDead ? this._exitCode(s) : null;
    this._reap(s);
    this.sessions.delete(id);
    return { final_output, exit_code };
  }

  list() {
    const out = [];
    for (const s of this.sessions.values()) {
      this._update(s);
      out.push({
        session_id: s.session_id,
        command: [s.command, ...(s.args || [])].join(" "),
        state: this._dead(s) ? "exited" : s.lastState,
        age_ms: Date.now() - s.createdAt,
      });
    }
    return out;
  }

  // reap idle sessions past the ceiling; called opportunistically on each tool call
  reapIdle() {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (now - s.lastActivity > IDLE_CEILING_MS) {
        this._reap(s);
        this.sessions.delete(id);
      }
    }
  }
}

export { SessionManager };
