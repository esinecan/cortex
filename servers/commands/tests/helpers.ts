import { spawnSync } from "node:child_process";

/**
 * Platform-aware test helpers.
 *
 * The integration tests run real commands through node's `exec`, which uses
 * /bin/sh on POSIX and cmd.exe on Windows. These helpers keep the assertions
 * honest on both: shells are detected rather than assumed, line endings are
 * normalized deliberately (cmd.exe emits CRLF), and shell-specific suites skip
 * with an explicit reason only when the shell is genuinely absent.
 */

export const isWindows = process.platform === "win32";

const availabilityCache = new Map<string, boolean>();

/**
 * True if `name` resolves on PATH for child processes spawned by these tests.
 * Uses `where` on Windows and `which` on POSIX, cached per process.
 */
export function commandAvailable(name: string): boolean {
    const cached = availabilityCache.get(name);
    if (cached !== undefined) {
        return cached;
    }
    const locator = isWindows ? "where" : "which";
    const result = spawnSync(locator, [name], { stdio: "ignore" });
    const available = result.status === 0;
    availabilityCache.set(name, available);
    return available;
}

/**
 * Returns a describe block gated on a command being installed. When the
 * command is absent the whole block is skipped and the suite title carries
 * the reason, so a skip is visible and attributable in the test report.
 */
export function describeIfAvailable(
    command: string,
    title: string
): [typeof describe, string] {
    if (commandAvailable(command)) {
        return [describe, title];
    }
    return [
        describe.skip,
        `${title} [skipped: '${command}' not installed on this machine]`,
    ];
}

/** Collapse CRLF to LF so expectations can be written once, in LF. */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

/**
 * Convert a native path to the form bash's `pwd` prints for it.
 * On Windows (Git Bash / MSYS): C:\Users\x -> /c/Users/x. Elsewhere: identity.
 */
export function toBashPath(nativePath: string): string {
    if (!isWindows) {
        return nativePath;
    }
    return nativePath
        .replace(/^([A-Za-z]):[\\/]/, (_m, drive: string) => `/${drive.toLowerCase()}/`)
        .replace(/\\/g, "/");
}
