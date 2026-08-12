import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tests for the gh CLI executor with the child_process boundary mocked.
 * No gh binary is invoked and no network is touched.
 *
 * executor.ts does `promisify(exec)` at module load, so the mock exposes the
 * promisified implementation via the `nodejs.util.promisify.custom` symbol —
 * the same mechanism node itself uses for exec.
 */

const execAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => {
    const exec: any = vi.fn();
    exec[Symbol.for("nodejs.util.promisify.custom")] = execAsyncMock;
    return { exec, default: { exec } };
});

import { checkGhCli, execGh, execGhJson, execGhApi } from "../src/core/executor.js";

function rejectionWith(props: Record<string, unknown>): Error {
    return Object.assign(new Error(String(props.message ?? "exec failed")), props);
}

beforeEach(() => {
    execAsyncMock.mockReset();
});

describe("checkGhCli", () => {
    test("reports available with the first line of gh --version", async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command === "gh --version") {
                return {
                    stdout: "gh version 2.40.0 (2024-01-01)\nhttps://github.com/cli/cli/releases\n",
                    stderr: "",
                };
            }
            if (command === "gh auth status") {
                return { stdout: "", stderr: "" };
            }
            throw new Error(`unexpected command: ${command}`);
        });

        const result = await checkGhCli();

        expect(result.available).toBe(true);
        expect(result.version).toBe("gh version 2.40.0 (2024-01-01)");
        expect(result.error).toBeUndefined();
    });

    test("reports unauthenticated when gh auth status fails", async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command === "gh --version") {
                return { stdout: "gh version 2.40.0\n", stderr: "" };
            }
            throw rejectionWith({ message: "not logged in" });
        });

        const result = await checkGhCli();

        expect(result.available).toBe(false);
        expect(result.error).toContain("not authenticated");
    });

    test("reports missing CLI when gh --version fails", async () => {
        execAsyncMock.mockRejectedValue(rejectionWith({ code: "ENOENT" }));

        const result = await checkGhCli();

        expect(result.available).toBe(false);
        expect(result.error).toContain("gh CLI not found in PATH");
    });
});

describe("execGh", () => {
    test("joins args into a gh command and returns stdout", async () => {
        execAsyncMock.mockResolvedValue({ stdout: "raw output", stderr: "" });

        const result = await execGh(["pr", "list", "--repo", "o/r"]);

        expect(result).toBe("raw output");
        expect(execAsyncMock).toHaveBeenCalledTimes(1);
        const [command, options] = execAsyncMock.mock.calls[0];
        expect(command).toBe("gh pr list --repo o/r");
        expect(options).toMatchObject({ maxBuffer: 10 * 1024 * 1024 });
        expect(options.timeout).toBeGreaterThan(0);
    });

    test("maps HTTP 403 stderr to a rate-limit error", async () => {
        execAsyncMock.mockRejectedValue(
            rejectionWith({ stderr: "gh: HTTP 403: rate limit exceeded" })
        );

        await expect(execGh(["api", "/user"])).rejects.toThrow(
            /rate limit exceeded/i
        );
    });

    test("maps HTTP 404 stderr to a not-found error", async () => {
        execAsyncMock.mockRejectedValue(
            rejectionWith({ stderr: "gh: HTTP 404: Not Found" })
        );

        await expect(execGh(["api", "/repos/x/y"])).rejects.toThrow(
            /Resource not found/
        );
    });

    test("maps ETIMEDOUT to a timeout error", async () => {
        execAsyncMock.mockRejectedValue(rejectionWith({ code: "ETIMEDOUT" }));

        await expect(execGh(["api", "/slow"])).rejects.toThrow(/timed out after/);
    });

    test("propagates stderr for other failures", async () => {
        execAsyncMock.mockRejectedValue(
            rejectionWith({ stderr: "gh: something else broke" })
        );

        await expect(execGh(["api", "/x"])).rejects.toThrow(
            "gh: something else broke"
        );
    });

    test("falls back to the error message when stderr is empty", async () => {
        execAsyncMock.mockRejectedValue(
            rejectionWith({ stderr: "", message: "spawn failure" })
        );

        await expect(execGh(["api", "/x"])).rejects.toThrow("spawn failure");
    });
});

describe("execGhJson", () => {
    test("parses JSON stdout", async () => {
        execAsyncMock.mockResolvedValue({
            stdout: '{"answer": 42}',
            stderr: "",
        });

        await expect(execGhJson(["api", "/x"])).resolves.toEqual({ answer: 42 });
    });

    test("throws a parse error including a stdout excerpt", async () => {
        execAsyncMock.mockResolvedValue({
            stdout: "this is not json",
            stderr: "",
        });

        await expect(execGhJson(["api", "/x"])).rejects.toThrow(
            /Failed to parse JSON response: this is not json/
        );
    });
});

describe("execGhApi", () => {
    beforeEach(() => {
        execAsyncMock.mockResolvedValue({ stdout: "{}", stderr: "" });
    });

    test("builds a plain endpoint call", async () => {
        await execGhApi("/user");

        expect(execAsyncMock.mock.calls[0][0]).toBe("gh api /user");
    });

    test("adds -X for method, -f for params, and --paginate", async () => {
        await execGhApi("/repos/o/r/issues", {
            method: "GET",
            params: { state: "open", per_page: 50 },
            paginate: true,
        });

        expect(execAsyncMock.mock.calls[0][0]).toBe(
            "gh api -X GET -f state=open -f per_page=50 --paginate /repos/o/r/issues"
        );
    });

    test("returns the parsed JSON payload", async () => {
        execAsyncMock.mockResolvedValue({
            stdout: '[{"login": "octocat"}]',
            stderr: "",
        });

        await expect(execGhApi("/orgs/x/members")).resolves.toEqual([
            { login: "octocat" },
        ]);
    });
});
