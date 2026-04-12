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
  command: string;
  args: string[];
  state: string;
  curatedTools?: string[];
  required?: boolean;
  env?: Record<string, string>;
}

interface RawExternalEntry {
  command: string;
  args: (string | number)[];
  discovery_state: string;
  curated_tools: string[];
  required?: boolean;
  env?: Record<string, string>;
  env_from_claude?: string;
}

interface RawVendoredEntry {
  entry: string;
  discovery_state: string;
  curated_tools: string[];
  required?: boolean;
  env?: Record<string, string>;
  env_from_claude?: string;
}

interface RawConfig {
  external?: Record<string, RawExternalEntry>;
  vendored?: Record<string, RawVendoredEntry>;
}

function substituteVars(value: string, projectRoot: string): string {
  return value
    .replace(/\$HOME/g, homedir())
    .replace(/\$PROJECT_ROOT/g, projectRoot);
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
      const env = config?.mcpServers?.[serverName]?.env
        || config?.servers?.[serverName]?.env;
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
      const resolvedArgs = cfg.args.map(a => substituteVars(String(a), projectRoot));
      const env = resolveEnv(cfg.env, cfg.env_from_claude);

      configs.push({
        name,
        command: cfg.command,
        args: resolvedArgs,
        state: cfg.discovery_state,
        curatedTools: cfg.curated_tools,
        required: cfg.required,
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
        required: cfg.required,
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
