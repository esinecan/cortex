/**
 * Config loader for mcp-servers.yaml.
 * Reads external and vendored MCP server definitions, resolves variables,
 * and returns ProxyConfig-compatible objects for the proxy infrastructure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

export interface McpServerEntry {
  name: string;
  /** stdio servers: program to spawn. Absent for url servers. */
  command?: string;
  args?: string[];
  /** HTTP servers: Streamable HTTP endpoint of an already-running daemon. */
  url?: string;
  /** Prefix added to remote tool names when registering locally (the remote
   *  is still called with its own name). For daemons that list bare names. */
  toolPrefix?: string;
  state: string;
  curatedTools?: string[];
  env?: Record<string, string>;
}

interface RawExternalEntry {
  command?: string;
  args?: (string | number)[];
  url?: string;
  tool_prefix?: string;
  discovery_state: string;
  curated_tools: string[];
  env?: Record<string, string>;
  env_from_claude?: string;
}

interface RawVendoredEntry {
  entry: string;
  discovery_state: string;
  curated_tools: string[];
  env?: Record<string, string>;
  env_from_claude?: string;
}

interface RawConfig {
  external?: Record<string, RawExternalEntry>;
  vendored?: Record<string, RawVendoredEntry>;
}

function substituteVars(value: string, projectRoot: string): string {
  return value.replace(/\$HOME/g, homedir()).replace(/\$PROJECT_ROOT/g, projectRoot);
}

/**
 * Read env vars from ~/.claude.json (or VS Code mcp.json) for a given server name.
 * Returns empty object if not found.
 */
export function getClaudeEnv(serverName: string): Record<string, string> {
  const candidates = [
    join(homedir(), '.claude.json'),
    join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json'),
    join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
  ];
  for (const configPath of candidates) {
    try {
      if (!existsSync(configPath)) continue;
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const env = config?.mcpServers?.[serverName]?.env || config?.servers?.[serverName]?.env;
      if (env && Object.keys(env).length > 0) return env;
    } catch {
      // continue to next candidate
    }
  }
  return {};
}

/**
 * Load MCP server configs from mcp-servers.yaml.
 * Resolves $HOME and $PROJECT_ROOT in args, merges env from claude config.
 */
export function loadMcpServers(projectRoot: string): McpServerEntry[] {
  const configPath = join(projectRoot, 'mcp-servers.yaml');
  const raw = parseYaml(readFileSync(configPath, 'utf-8')) as RawConfig;
  const configs: McpServerEntry[] = [];

  if (raw.external) {
    for (const [name, cfg] of Object.entries(raw.external)) {
      const env = resolveEnv(cfg.env, cfg.env_from_claude);

      if (cfg.url) {
        // Already-running HTTP daemon (e.g. isession): connect, don't spawn.
        configs.push({
          name,
          url: substituteVars(cfg.url, projectRoot),
          ...(cfg.tool_prefix ? { toolPrefix: cfg.tool_prefix } : {}),
          state: cfg.discovery_state,
          curatedTools: cfg.curated_tools,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });
        continue;
      }
      if (!cfg.command) {
        throw new Error(`mcp-servers.yaml: external server '${name}' needs 'command' or 'url'`);
      }
      const resolvedArgs = (cfg.args || []).map((a) => substituteVars(String(a), projectRoot));

      configs.push({
        name,
        command: cfg.command,
        args: resolvedArgs,
        ...(cfg.tool_prefix ? { toolPrefix: cfg.tool_prefix } : {}),
        state: cfg.discovery_state,
        curatedTools: cfg.curated_tools,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
    }
  }

  if (raw.vendored) {
    for (const [name, cfg] of Object.entries(raw.vendored)) {
      const entryPath = join(projectRoot, cfg.entry);
      const env = resolveEnv(cfg.env, cfg.env_from_claude);

      configs.push({
        name,
        command: 'node',
        args: [entryPath],
        state: cfg.discovery_state,
        curatedTools: cfg.curated_tools,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
    }
  }

  return configs;
}

/**
 * Resolve env vars: merge from claude config, then overlay explicit values.
 * process.env takes precedence over claude config which takes precedence over YAML defaults.
 */
function resolveEnv(
  explicitEnv?: Record<string, string>,
  envFromClaude?: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (envFromClaude) {
    Object.assign(env, getClaudeEnv(envFromClaude));
  }

  if (explicitEnv) {
    for (const [k, v] of Object.entries(explicitEnv)) {
      env[k] = process.env[k] || env[k] || v;
    }
  }

  return env;
}
