# Contributing to Cortex

Cortex is designed to be extended. The most common extension points are:

## Adding a New State

1. Add the state definition to `states.yaml`:

```yaml
my_state:
  description: 'What this state is for.'
  tools:
    - my_tool_one
    - my_tool_two
  external_guidance:
    use: [read, grep]
    avoid: [edit]
  constraints:
    - 'A rule the agent must follow in this state'
```

2. Create a tool registration file at `src/tools/my-state.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';

export function registerMyStateTools(server: McpServer, state: StateManager): void {
  const handle = server.registerTool(
    'my_tool_one',
    {
      description: 'What this tool does',
      inputSchema: {
        param: z.string().describe('Parameter description'),
      },
    },
    async (args) => {
      return { content: [{ type: 'text' as const, text: 'result' }] };
    },
  );
  state.registerTool('my_tool_one', 'my_state', handle);
}
```

3. Register in `src/index.ts`:

```typescript
import { registerMyStateTools } from './tools/my-state.js';
// ... in main():
registerMyStateTools(server, state);
```

## Adding a Leveled State

States can have progressive levels (like validate L1→L2→L3):

```yaml
my_leveled_state:
  description: 'Progressive capability.'
  levels:
    1:
      tools: [basic_tool]
      constraints: ['Start here']
    2:
      inherits: 1
      additional_tools: [advanced_tool]
      constraints: ['Unlocked after L1']
    3:
      inherits: 2
      additional_tools: [expert_tool]
      constraints: ['Full capability']
```

Level inheritance walks the chain: L3 gets L1 + L2 + L3 tools.

## Adding a Pathway

Add to `pathways.yaml`:

```yaml
my_pathway:
  description: 'What this workflow does'
  initial_state: recon
  sequence: [recon, implement, review]
  guidance:
    recon:
      - 'Step 1 in recon'
      - 'Step 2 in recon'
    implement:
      - 'Step 1 in implement'
    review:
      - 'Step 1 in review'
```

For leveled guidance (e.g., validate):

```yaml
validate:
  l1:
    - 'L1 guidance'
  l2:
    - 'L2 guidance'
```

## Adding an MCP Server Bridge

See [BRIDGES.md](BRIDGES.md) for the full guide. The short version:

1. Add an entry to `mcp-servers.yaml`
2. Set `discovery_state` to the state where its tools should appear
3. List `curated_tools` (the subset visible in the state; others remain discoverable)
4. Restart cortex

## Running Tests

```bash
npm test              # single run
npm run test:watch    # watch mode
```

Tests live in `tests/` and use [Vitest](https://vitest.dev/). Each test file isolates storage by creating a temp directory.

## Code Style

- ESLint with `@typescript-eslint` strict rules
- Prettier for formatting
- Run `npm run lint` and `npm run format` before submitting changes
