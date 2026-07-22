# isession-mcp

An MCP server that holds a **live terminal session** and lets a driving agent send input and
read evolving output across many model turns within one run. Canonical target: `pi` in
interactive mode. Lives in the Cortex MCP harness (the "anything can be an MCP server" slot),
so any agent in the harness can drive an interactive program instead of fire-and-forgetting it.

Backend: **tmux**. Each session is a detached tmux session, which gives a PTY + vt100 renderer
(`capture-pane`) + process-group isolation (`kill-session` reaps the whole group) with zero
native dependencies — only Node builtins and a `tmux` binary.

## Tools

| tool | what it does |
| --- | --- |
| `isession_open(command, args, env?, cwd?, cols=120, rows=40, profile="auto")` | open a persistent PTY session; returns first screen + state + cursor |
| `isession_send(session_id, input, submit=true)` | type text; submit appends Enter |
| `isession_read(session_id, mode="screen")` | read without sending; `screen \| delta \| tail:N \| full` |
| `isession_wait(session_id, until="prompt", timeout_ms=30000)` | block until `prompt \| idle:Nms \| pattern:<rx> \| exit` |
| `isession_signal(session_id, signal)` | `INT \| TERM \| EOF \| key:<name>` (C-c, C-d, Enter, Up, Down, Esc) |
| `isession_close(session_id)` | reap the process group; return final output + exit_code |
| `isession_list()` | live sessions |

State held in the MCP server process, keyed by `session_id`, for the life of the run (so
successive `tools/call`s from one driver share the same PTY — the load-bearing assumption in
spec §9.2).

## The state model (the crux)

Every response carries `state`: `running` | `awaiting_input` | `exited`.
- Quiescence: no new bytes for `idle_ms` (default 500).
- Prompt match: last non-empty lines match a prompt regex from the target's profile, or a
  generic set (`[$#>]\s*$`, `(y/n)`, `Password:`, `>>>`).
- Verdict: `awaiting_input` when quiescent AND (prompt matched OR idle beyond a ceiling).
  Blank/booting screens are never falsely handed back.

**Hard rule:** the raw rendered screen is always returned alongside the verdict. The detector
is a hint; the driving model is the arbiter.

## Prompt profiles

`generic` + `pi`:
- pi ready: footer model line `(zai) <model> • <reasoning>`.
- pi busy: `MCP: connecting`, `Thinking...`, `Working...`, braille spinner frames.
- pi question (mid-session): the project-trust menu (`Trust project folder?`, `→ Trust`, …).

Add profiles for `pdb`, `psql`, wizards in `build/profiles.js`.

## Lifecycle / safety

Session-bound; reaped on `close`, on server shutdown (SIGTERM/SIGINT/SIGHUP), and on an idle
ceiling (default 10 min). Process-group kill via `kill-session` (nothing orphans). Caps: 8
concurrent sessions, 4 MB buffer. Launched under a login shell so provider keys load (the
`ZAI_API_KEY` login-shell rule).

## Run

```bash
node drive_demo.js sanity   # bash echo via the full MCP round-trip
node drive_demo.js pi       # acceptance: drive pi through a mid-session trust decision
```

`drive_demo.js` is a dependency-free MCP stdio client that spawns this server **once** and
exercises the seven tools across many `tools/call` round-trips — proving session state
persists across calls.
