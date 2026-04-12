/**
 * gh CLI executor - wrapper for running gh commands
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const TIMEOUT_MS = parseInt(process.env.GH_MCP_TIMEOUT_MS || "30000", 10);
const DEBUG = process.env.GH_MCP_DEBUG === "true";

interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Check if gh CLI is available and authenticated
 */
export async function checkGhCli(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const { stdout } = await execAsync("gh --version", { timeout: 5000 });
    const version = stdout.trim().split("\n")[0];
    
    // Check if authenticated
    try {
      await execAsync("gh auth status", { timeout: 5000 });
      return { available: true, version };
    } catch {
      return { available: false, error: "gh CLI is not authenticated. Run: gh auth login" };
    }
  } catch {
    return { available: false, error: "gh CLI not found in PATH" };
  }
}

/**
 * Execute a gh command and return raw stdout
 */
export async function execGh(args: string[]): Promise<string> {
  const command = `gh ${args.join(" ")}`;
  
  if (DEBUG) {
    console.error(`[gh-mcp] Executing: ${command}`);
  }

  try {
    const { stdout, stderr } = await execAsync(command, { 
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large responses
    });
    
    if (DEBUG && stderr) {
      console.error(`[gh-mcp] stderr: ${stderr}`);
    }
    
    return stdout;
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message: string; code?: string };
    
    // Handle specific error cases
    if (execError.stderr?.includes("HTTP 403")) {
      throw new Error("GitHub API rate limit exceeded. Please wait and try again.");
    }
    if (execError.stderr?.includes("HTTP 404")) {
      throw new Error("Resource not found. Check owner/repo/path parameters.");
    }
    if (execError.code === "ETIMEDOUT") {
      throw new Error(`Command timed out after ${TIMEOUT_MS}ms`);
    }
    
    throw new Error(execError.stderr || execError.message);
  }
}

/**
 * Execute a gh command and parse JSON output
 */
export async function execGhJson<T>(args: string[]): Promise<T> {
  const stdout = await execGh(args);
  
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`Failed to parse JSON response: ${stdout.substring(0, 200)}`);
  }
}

/**
 * Execute gh api command
 */
export async function execGhApi<T>(
  endpoint: string, 
  options: { 
    method?: string;
    params?: Record<string, string | number | boolean>;
    paginate?: boolean;
  } = {}
): Promise<T> {
  const args = ["api"];
  
  if (options.method) {
    args.push("-X", options.method);
  }
  
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined && value !== null) {
        args.push("-f", `${key}=${value}`);
      }
    }
  }
  
  if (options.paginate) {
    args.push("--paginate");
  }
  
  args.push(endpoint);
  
  return execGhJson<T>(args);
}
