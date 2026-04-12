/**
 * File content tools: get_file_contents
 */

import { execGhApi } from "../core/executor.js";
import type { GetFileContentsInput } from "../core/types.js";

export async function getFileContents(args: Record<string, unknown>): Promise<unknown> {
  const { owner, repo, path = "", ref, sha } = args as unknown as GetFileContentsInput;

  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  let endpoint = `/repos/${owner}/${repo}/contents/${cleanPath}`;

  // sha takes precedence over ref
  const gitRef = sha || ref;
  if (gitRef) {
    endpoint += `?ref=${encodeURIComponent(gitRef)}`;
  }

  const result = await execGhApi<any>(endpoint);

  // If it's a file (not directory), decode base64 content and clean up redundant fields
  if (result.type === "file" && result.content && result.encoding === "base64") {
    try {
      result.decoded_content = Buffer.from(result.content, "base64").toString("utf-8");
      // Remove redundant fields to save context window space
      delete result.content;
      delete result.encoding;
    } catch {
      // Keep base64 if decode fails
    }
  }

  // Remove redundant URL fields - html_url is sufficient for navigation
  delete result._links;
  delete result.url;
  delete result.git_url;
  delete result.download_url;

  return result;
}
