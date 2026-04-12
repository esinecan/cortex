import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StateManager } from '../state.js';
import { updateTask } from '../tasks.js';

function success(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Debug tools: hypothesis tracking, log guidance, database query guidance,
 * distributed tracing, and root cause recording. Flat (no levels).
 */
export function registerDebugTools(server: McpServer, state: StateManager): void {

  const hypothesisHandle = server.registerTool(
    'debug_hypothesis',
    {
      description: 'Log a hypothesis with confidence percentage. Forces explicit reasoning before querying.',
      inputSchema: {
        description: z.string().describe('Your hypothesis about the root cause'),
        confidence: z.preprocess(
          (val) => typeof val === 'string' ? Number(val) : val,
          z.number().min(0).max(100),
        ).describe('Confidence percentage (0-100)'),
      },
    },
    async (args) => {
      const finding = `[hypothesis:${args.confidence}%] ${args.description}`;
      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'debug');
      }
      return success(`Hypothesis logged (${args.confidence}% confidence):\n\n${args.description}`);
    },
  );
  state.registerTool('debug_hypothesis', 'debug', hypothesisHandle);

  const logCheckHandle = server.registerTool(
    'debug_log_check',
    {
      description: 'Get guidance for checking logs of a service. Returns suggested commands for your log tooling.',
      inputSchema: {
        service: z.string().describe('Service name (e.g. api-gateway, worker-service)'),
        query: z.string().describe('What to look for in the logs'),
        environment: z.enum(['sandbox', 'production']).optional().describe('Environment (default: sandbox)'),
      },
    },
    async (args) => {
      const env = args.environment || 'sandbox';
      const ns = env === 'production' ? 'production' : 'sandbox';

      return success([
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
        'Use your observability platform\'s log search (e.g. Datadog, Grafana Loki, CloudWatch).',
        '(could be an external tool paired with cortex)',
        '',
        'Record findings via `debug_hypothesis` or `debug_root_cause`.',
      ].join('\n'));
    },
  );
  state.registerTool('debug_log_check', 'debug', logCheckHandle);

  const dbQueryHandle = server.registerTool(
    'debug_db_query',
    {
      description: 'Get guidance for database queries. Available in debug state.',
      inputSchema: {
        collection: z.string().describe('Collection or table name'),
        query_description: z.string().describe('What you want to find'),
      },
    },
    async (args) => {
      return success([
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
        'Record findings to task. (could be an external tool paired with cortex)',
        '',
        'Use `debug_distributed_trace` if cross-service correlation is needed.',
      ].join('\n'));
    },
  );
  state.registerTool('debug_db_query', 'debug', dbQueryHandle);

  const traceHandle = server.registerTool(
    'debug_distributed_trace',
    {
      description: 'Get guidance for distributed tracing across services.',
      inputSchema: {
        correlation_id: z.string().describe('Correlation ID, request ID, or trace ID'),
      },
    },
    async (args) => {
      return success([
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
        '',
        'Record root cause via `debug_root_cause` when found.',
      ].join('\n'));
    },
  );
  state.registerTool('debug_distributed_trace', 'debug', traceHandle);

  const rootCauseHandle = server.registerTool(
    'debug_root_cause',
    {
      description: 'Record the root cause finding. Persists to task and suggests next steps.',
      inputSchema: {
        description: z.string().describe('Root cause description'),
        evidence: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.string()),
        ).describe('Evidence supporting the root cause'),
      },
    },
    async (args) => {
      const evidence = args.evidence as string[];
      const finding = `[root-cause] ${args.description}\nEvidence:\n${evidence.map(e => `  - ${e}`).join('\n')}`;

      const taskId = state.getActiveTaskId();
      if (taskId) {
        updateTask(taskId, { findings: finding }, 'debug');
      }

      return success([
        `## Root Cause Identified`,
        '',
        args.description,
        '',
        '### Evidence',
        ...evidence.map(e => `- ${e}`),
        '',
        '### Next Steps',
        '- `enter_state("implement")` to fix the issue',
        '- `enter_state("review")` if the fix is already in place',
      ].join('\n'));
    },
  );
  state.registerTool('debug_root_cause', 'debug', rootCauseHandle);
}
