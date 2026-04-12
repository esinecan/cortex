# Cortex

**An executive function layer for AI agents, designed like a choose-your-own-adventure book.**

States are chapters. Pathways are storylines. Tools appear based on where you are in the story.  
The agent doesn't see everything at once -- it sees what's relevant to the current phase of work,  
guided through structured workflows that enforce good engineering discipline.

Cortex is an [MCP](https://modelcontextprotocol.io/) server that sits between your AI agent (Claude, etc.) and the tools it uses. It manages **what tools are visible when**, **what the agent should do next**, and **what it remembers across sessions**.

---

## How It Works

```
                  ┌─────────────────────────────────┐
                  │           AI Agent               │
                  │   (Claude, etc.)                  │
                  └──────────┬──────────────────────-─┘
                             │ MCP Protocol
                  ┌──────────▼──────────────────────-─┐
                  │          Cortex                    │
                  │                                    │
                  │  ┌─────────┐  ┌───────────────┐   │
                  │  │  State  │  │  Persistent   │   │
                  │  │ Machine │  │    Tasks      │   │
                  │  └────┬────┘  └───────────────┘   │
                  │       │                            │
                  │  ┌────▼────────────────────────┐   │
                  │  │    Tool Visibility Gate      │   │
                  │  │  (only shows tools for the   │   │
                  │  │   current state/chapter)     │   │
                  │  └────┬────────────────────────┘   │
                  └───────┼────────────────────────-───┘
                          │ proxies
           ┌──────────────┼──────────────────┐
           │              │                  │
     ┌─────▼───┐   ┌─────▼────┐    ┌────────▼──────┐
     │Playwright│   │  GitHub  │    │   Commands    │
     │ (browse) │   │  (recon) │    │ (implement)   │
     └──────────┘   └──────────┘    └───────────────┘
              ... any MCP server you want ...
```

### The State Machine

At any moment, the agent is in one **state** (chapter). Each state exposes a specific set of tools and enforces constraints. This prevents the agent from editing code during investigation, or running tests before it has a plan.

| State       | Chapter       | What the Agent Does                                  |
| ----------- | ------------- | ---------------------------------------------------- |
| `base`      | Title Page    | Pick a task, choose a direction                      |
| `recon`     | Investigation | Read code, search docs, gather context               |
| `plan`      | Blueprint     | Draft a plan, validate it, get approval              |
| `implement` | Workshop      | Write code, run tests, checkpoint progress           |
| `debug`     | Detective     | Form hypotheses, check logs, trace issues            |
| `validate`  | Quality Gate  | Prerequisites → flow checks → browser E2E (L1→L2→L3) |
| `review`    | Mirror        | Simulate reviewers, run checklists, prep PR          |
| `browse`    | Library       | Focused web research with Playwright                 |
| `free`      | Wildcard      | Escape hatch -- all tools, no constraints            |

### Pathways (Storylines)

Pathways are named sequences of states with step-by-step guidance at each stage:

| Pathway         | Flow                                         | When to Use                 |
| --------------- | -------------------------------------------- | --------------------------- |
| `golden`        | recon → plan → implement → validate → review | Feature development         |
| `investigation` | debug → implement → validate → review        | Bug fixing                  |
| `knowledge`     | recon                                        | Quick domain questions      |
| `e2e_verify`    | validate (L1→L2→L3)                          | Standalone E2E verification |
| `code_review`   | recon → review                               | Reviewing someone's PR      |
| `free_roam`     | free                                         | Open-ended work             |
| `introspect`    | recon → plan → implement → validate          | Self-audit of cortex itself |

### Persistent Tasks

Tasks survive across sessions. They accumulate findings, track state history, and support subtask hierarchy. When the agent resumes a task tomorrow, `task_context` reconstructs everything from the previous session.

### Dynamic Pathways

Beyond static pathways, agents can generate pathways at runtime with `pathway_generate`. Each step has acceptance criteria that must be proven with evidence before the agent can advance -- turning the workflow into a gated, verifiable process.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/esinecan/cortex.git
cd cortex
npm install

# Build
npm run build

# Run (stdio transport for MCP)
npm start
```

### Connect to Claude Code

Add to your Claude Code MCP config (`~/.claude.json` or VS Code `mcp.json`):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/index.js"]
    }
  }
}
```

### Connect to VS Code (Copilot Chat)

Add to your VS Code settings or `.vscode/mcp.json`:

```json
{
  "servers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/index.js"]
    }
  }
}
```

---

## Configuration

Cortex is configured entirely through YAML files:

| File               | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `states.yaml`      | State definitions -- tools, constraints, external guidance per state |
| `pathways.yaml`    | Pathway definitions -- state sequences with per-step guidance        |
| `mcp-servers.yaml` | External MCP servers to proxy -- pluggable integrations              |

### Adding Your Own MCP Servers

Any MCP server can be plugged into cortex by adding an entry to `mcp-servers.yaml`:

```yaml
# Example: adding a Datadog MCP server for debug state
external:
  datadog:
    command: node
    args: [/path/to/datadog-mcp/server.js]
    discovery_state: debug
    curated_tools:
      - dd_search_logs
      - dd_top_values
```

The server's tools will automatically appear when the agent enters the `debug` state. See [BRIDGES.md](BRIDGES.md) for the full integration guide.

### Default Servers

Cortex ships with these integrations:

| Server       | State     | What It Provides                                    |
| ------------ | --------- | --------------------------------------------------- |
| Playwright   | browse    | Browser automation for E2E testing and web research |
| Brave Search | recon     | Web search and summarization                        |
| GitHub       | recon     | Repository exploration, PR reading, code search     |
| Commands     | implement | Shell command execution                             |

---

## Architecture

```
src/
├── index.ts          # Entry point -- 6-stage initialization
├── state.ts          # StateManager -- the state machine core
├── states.ts         # YAML loader + level inheritance resolver
├── pathways.ts       # Pathway definitions + guidance formatter
├── proxy.ts          # MCP proxy -- JSON Schema → Zod conversion
├── storage.ts        # Persistence layer (~/.cortex/)
├── tasks.ts          # Task CRUD + markdown rendering
├── instructions.ts   # Built-in MCP instructions
├── config.ts         # MCP server config loader
├── types.ts          # TypeScript interfaces
└── tools/
    ├── always-on.ts  # Task CRUD, state transitions, discovery
    ├── recon.ts      # Reconnaissance tools
    ├── plan.ts       # Planning tools
    ├── implement.ts  # Implementation tools
    ├── debug.ts      # Debugging tools
    ├── validate.ts   # Validation tools (L1-L3)
    ├── review.ts     # PR review tools
    ├── browse.ts     # Browser journaling
    └── pathway.ts    # Dynamic pathway tools
```

### Key Design Decisions

- **Declarative over imperative**: States, pathways, and server configs are YAML. The engine is generic.
- **Tool visibility gating**: Tools don't exist outside their state. The agent can't accidentally run tests during recon.
- **Persistent everything**: Tasks, findings, state history survive session death. The agent picks up where it left off.
- **Progressive capability**: Leveled states (validate L1→L2→L3) gate complexity. Simple checks before browser automation.
- **Pluggable backends**: Swap Datadog for Grafana, MongoDB for PostgreSQL -- cortex doesn't care. Add a YAML entry, restart.

---

## Development

```bash
# Watch mode (rebuild on change)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint
npm run lint

# Format
npm run format

# Launch MCP Inspector for debugging
npm run inspect
```

---

## License

MIT
