import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';
import { respond } from '../respond.js';

/**
 * Debug tools across three progressive levels:
 * L1 -- hypothesis tracking, log guidance, and level advancement,
 * L2 -- database query guidance,
 * L3 -- distributed tracing and root cause recording.
 */
export function registerDebugTools(server: McpServer, state: StateManager): void {
  // -- Level 1: Hypothesis and logs --
  const hypothesisHandle = server.registerTool(
    'debug_hypothesis',
    {
      description:
        'Log a hypothesis with confidence percentage. Forces explicit reasoning before querying.',
      inputSchema: {
        description: z.string().describe('Your hypothesis about the root cause'),
        confidence: z
          .preprocess(
            (val) => (typeof val === 'string' ? Number(val) : val),
            z.number().min(0).max(100),
          )
          .describe('Confidence percentage (0-100)'),
      },
    },
    async (args) => {
      const finding = `[hypothesis:${args.confidence}%] ${args.description}`;
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'debug');
      }
      return respond(
        state,
        `Hypothesis logged (${args.confidence}% confidence):\n\n${args.description}`,
        'Gather evidence to confirm or refute. Use `debug_log_check` or `debug_db_query`.',
      );
    },
  );
  state.registerTool('debug_hypothesis', 'debug', hypothesisHandle);

  const logCheckHandle = server.registerTool(
    'debug_log_check',
    {
      description:
        'Returns a log investigation plan for a service. Does not execute queries directly — use your observability tools to follow the plan.',
      inputSchema: {
        service: z.string().describe('Service name (e.g. api-gateway, worker-service)'),
        query: z.string().describe('What to look for in the logs'),
        environment: z
          .enum(['sandbox', 'production'])
          .optional()
          .describe('Environment (default: sandbox)'),
      },
    },
    async (args) => {
      const env = args.environment || 'sandbox';
      const ns = env === 'production' ? 'production' : 'sandbox';

      return respond(
        state,
        [
          `## Log Check: ${args.service}`,
          '',
          `**Looking for:** ${args.query}`,
          '',
          '### Container/cluster logs (if applicable)',
          '```bash',
          `# Example: kubectl logs -n ${ns} -l app=${args.service} --since=1h | grep -i "${args.query}"`,
          '# Adapt to your cluster management tools (could be an external tool paired with cortex)',
          '```',
          '',
          '### Observability platform',
          `Query pattern: \`service:${args.service} ${args.query}\``,
          "Use your observability platform's log search (e.g. Datadog, Grafana Loki, CloudWatch).",
          '(could be an external tool paired with cortex)',
        ].join('\n'),
        'Execute these queries, then `debug_hypothesis` to log what you find.',
      );
    },
  );
  state.registerTool('debug_log_check', 'debug', logCheckHandle);

  const advanceHandle = server.registerTool(
    'debug_advance',
    {
      description:
        'Advance to the next debug level. L1->L2 adds database investigation. L2->L3 adds distributed tracing and root-cause recording.',
    },
    async () => {
      const result = state.advanceLevel();
      if (result.error) return respond(state, result.error);

      const levelDescriptions: Record<number, string> = {
        2: 'Level 2: Database investigation enabled. Use `debug_db_query` for data state checks.',
        3: 'Level 3: Cross-service tracing enabled. Use `debug_distributed_trace` and finalize with `debug_root_cause`.',
      };

      return respond(
        state,
        `Advanced to debug ${levelDescriptions[result.level!] || `level ${result.level}`}`,
      );
    },
  );
  state.registerTool('debug_advance', 'debug', advanceHandle);

  // -- Level 2: Database investigation --

  const dbQueryHandle = server.registerTool(
    'debug_db_query',
    {
      description:
        'Returns a database investigation plan. Does not execute queries directly — use your database tools to follow the plan.',
      inputSchema: {
        collection: z.string().describe('Collection or table name'),
        query_description: z.string().describe('What you want to find'),
      },
    },
    async (args) => {
      return respond(
        state,
        [
          `## DB Query: ${args.collection}`,
          '',
          `**Looking for:** ${args.query_description}`,
          '',
          '### Entity Map',
          'Collections/tables and their domain meaning:',
          '(No entity map configured. Add a domain entity map to your cortex config to populate this section.)',
          '- Example: `orders` -- Customer order records',
          '- Example: `products` -- Product catalog',
          '',
          '### Suggested Query',
          'Use your database tooling (mongosh, psql, your DB MCP server) to query.',
        ].join('\n'),
        'Query your database, then `debug_hypothesis` or `debug_root_cause` with results.',
      );
    },
  );
  state.registerTool('debug_db_query', 'debug', dbQueryHandle);

  // -- Level 3: Distributed tracing and root cause --

  const traceHandle = server.registerTool(
    'debug_distributed_trace',
    {
      description:
        'Returns a distributed tracing plan. Does not execute queries directly — use your observability tools to follow the plan.',
      inputSchema: {
        correlation_id: z.string().describe('Correlation ID, request ID, or trace ID'),
      },
    },
    async (args) => {
      return respond(
        state,
        [
          `## Distributed Trace: ${args.correlation_id}`,
          '',
          '### Steps',
          `1. Search your observability platform for: \`correlation_id:${args.correlation_id}\` (could be an external tool paired with cortex)`,
          `2. Check service chain: entry point -> service -> downstream`,
          `3. Look for timing gaps between service boundaries`,
          `4. Check for retry storms or circuit breaker trips`,
          '',
          '### Cluster log search (if applicable)',
          '```bash',
          `# kubectl logs -n <namespace> -l app=<service-a> --since=1h | grep "${args.correlation_id}"`,
          `# kubectl logs -n <namespace> -l app=<service-b> --since=1h | grep "${args.correlation_id}"`,
          '# Adapt to your cluster management tools. (could be an external tool paired with cortex)',
          '```',
        ].join('\n'),
        'Execute the trace, then `debug_root_cause` when you find the issue.',
      );
    },
  );
  state.registerTool('debug_distributed_trace', 'debug', traceHandle);

  const rootCauseHandle = server.registerTool(
    'debug_root_cause',
    {
      description: 'Record the root cause finding. Persists to task and suggests next steps.',
      inputSchema: {
        description: z.string().describe('Root cause description'),
        evidence: z
          .preprocess(
            (val) => (typeof val === 'string' ? JSON.parse(val) : val),
            z.array(z.string()),
          )
          .describe('Evidence supporting the root cause'),
      },
    },
    async (args) => {
      const evidence = args.evidence as string[];
      const finding = `[root-cause] ${args.description}\nEvidence:\n${evidence.map((e) => `  - ${e}`).join('\n')}`;

      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'debug');
      }

      return respond(
        state,
        [
          `## Root Cause Identified`,
          '',
          args.description,
          '',
          '### Evidence',
          ...evidence.map((e) => `- ${e}`),
          '',
          '### Next Steps',
          '- `enter_state("implement")` to fix the issue',
          '- `enter_state("review")` if the fix is already in place',
        ].join('\n'),
      );
    },
  );
  state.registerTool('debug_root_cause', 'debug', rootCauseHandle);
}
