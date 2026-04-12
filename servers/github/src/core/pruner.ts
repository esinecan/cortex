/**
 * Response pruning utility for gh-mcp
 * 
 * Strips verbose GitHub API metadata to reduce response size and LLM context pollution.
 * Smart enough to remove bot noise while preserving human-useful content.
 */

// ============================================================================
// BODY SANITIZATION
// ============================================================================

/**
 * Remove coderabbit internal state markers (base64 garbage)
 * These look like: <!-- DwQgtGAEAqAWCWBnSTIEMB26CuAXA9m... -->
 */
const CODERABBIT_STATE_PATTERN = /<!--\s*[A-Za-z0-9+/=]{20,}\s*-->/g;

/**
 * Remove coderabbit walkthrough blocks - rarely useful, LLM already summarizes
 * These are between <!-- walkthrough_start --> and <!-- walkthrough_end -->
 */
const CODERABBIT_WALKTHROUGH_PATTERN = /<!--\s*walkthrough_start\s*-->[\s\S]*?<!--\s*walkthrough_end\s*-->/g;

/**
 * Remove coderabbit tips blocks
 */
const CODERABBIT_TIPS_PATTERN = /<!--\s*tips_start\s*-->[\s\S]*?<!--\s*tips_end\s*-->/g;

/**
 * Remove HTML comments that are just markers (common in bot comments)
 */
const HTML_COMMENT_MARKERS = /<!--[^>]*(?:start|end|coderabbit|auto-generated)[^>]*-->/gi;

/**
 * Clean up comment/PR body text by removing bot noise
 */
function sanitizeBody(text: string): string {
    return text
        // Remove coderabbit internal state (base64 garbage)
        .replace(CODERABBIT_STATE_PATTERN, '')
        // Remove walkthrough blocks
        .replace(CODERABBIT_WALKTHROUGH_PATTERN, '[walkthrough removed]')
        // Remove tips blocks  
        .replace(CODERABBIT_TIPS_PATTERN, '')
        // Remove other marker comments
        .replace(HTML_COMMENT_MARKERS, '')
        // Collapse multiple newlines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============================================================================
// FIELD FILTERING
// ============================================================================

/**
 * Fields to KEEP on user objects. Everything else is stripped.
 * Just need to know WHO, not their entire GitHub profile.
 */
const KEEP_USER_FIELDS = new Set([
    "login",      // The username - essential
    "type",       // "User", "Bot", "Organization" - useful context
]);

/**
 * Fields to remove globally (from any object at any depth)
 */
const BLOAT_GLOBAL_FIELDS = new Set([
    "node_id",
    "gravatar_id",
    "performed_via_github_app", // Entire nested object - rarely useful
    "reactions",                // Mostly zeros, adds bloat
    "author_association",       // "NONE", "MEMBER" etc - rarely useful
    "client_id",                // App internal ID
    "permissions",              // App permissions - rarely useful
    "avatar_url",               // Don't need profile pics
    "issue_url",                // API endpoint, not useful
    "url",                      // API endpoint for the resource
    "repository",               // Full repo metadata with URL templates - huge bloat
    "commit_url",               // API endpoint
]);

/**
 * Fields to keep on comment/issue/PR objects
 */
const KEEP_ENTITY_FIELDS = new Set([
    "html_url",     // Direct link to GitHub web - very useful
    "id",           // Unique identifier
    "body",         // The actual content
    "created_at",   // When it was posted
    "updated_at",   // When it was modified
    "user",         // Who posted it (will be pruned recursively)
    "state",        // For PRs: open/closed/merged
    "title",        // For PRs/issues
    "number",       // PR/issue number
    "login",        // Username
    "type",         // User type
    "sha",          // Commit SHA
    "message",      // Commit message
    "author",       // Commit author
    "committer",    // Commit committer
    "commit",       // Commit object
    "files",        // Changed files
    "filename",     // File name
    "status",       // File status (added/modified/deleted)
    "additions",    // Lines added
    "deletions",    // Lines deleted
    "patch",        // Diff patch
]);

/**
 * Check if an object looks like a GitHub user/actor object
 */
function isUserObject(obj: Record<string, unknown>): boolean {
    return typeof obj["login"] === "string" &&
        (obj["type"] === "User" || obj["type"] === "Bot" || obj["type"] === "Organization" ||
            "followers_url" in obj || "gravatar_id" in obj);
}

// ============================================================================
// MAIN PRUNING FUNCTION
// ============================================================================

/**
 * Recursively prune a response object
 */
export function pruneResponse<T>(data: T): T {
    if (data === null || data === undefined) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map((item) => pruneResponse(item)) as T;
    }

    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;
        const isUser = isUserObject(obj);
        const result: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(obj)) {
            // Skip global bloat fields
            if (BLOAT_GLOBAL_FIELDS.has(key)) {
                continue;
            }

            // For user objects, only keep essential fields
            if (isUser && !KEEP_USER_FIELDS.has(key)) {
                continue;
            }

            // Sanitize body/description text (remove bot noise)
            if ((key === "body" || key === "description") && typeof value === "string") {
                const sanitized = sanitizeBody(value);
                // Only include if there's meaningful content left
                if (sanitized.length > 0) {
                    result[key] = sanitized;
                }
                continue;
            }

            // Recursively prune nested objects
            result[key] = pruneResponse(value);
        }

        return result as T;
    }

    // Primitives pass through unchanged
    return data;
}

/**
 * Calculate approximate size reduction for logging
 */
export function measurePruning(original: unknown, pruned: unknown): {
    originalSize: number;
    prunedSize: number;
    reduction: string;
} {
    const originalSize = JSON.stringify(original).length;
    const prunedSize = JSON.stringify(pruned).length;
    const reduction = ((1 - prunedSize / originalSize) * 100).toFixed(1);

    return { originalSize, prunedSize, reduction: `${reduction}%` };
}
