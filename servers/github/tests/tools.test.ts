import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tool registration and handler tests with the executor module mocked.
 * Every gh/GitHub call is intercepted at the execGh/execGhJson/execGhApi
 * boundary — nothing shells out, nothing hits the network.
 */

vi.mock("../src/core/executor.js", () => ({
    checkGhCli: vi.fn(),
    execGh: vi.fn(),
    execGhJson: vi.fn(),
    execGhApi: vi.fn(),
}));

import { execGh, execGhApi, execGhJson } from "../src/core/executor.js";
import { TOOLS, handleToolCall } from "../src/tools/index.js";

const execGhMock = vi.mocked(execGh);
const execGhJsonMock = vi.mocked(execGhJson);
const execGhApiMock = vi.mocked(execGhApi);

const EXPECTED_TOOL_NAMES = [
    "get_commit",
    "list_commits",
    "get_file_contents",
    "get_me",
    "get_teams",
    "get_team_members",
    "list_branches",
    "list_pull_requests",
    "pull_request_read",
    "search_code",
    "search_pull_requests",
    "search_repositories",
    "search_users",
];

beforeEach(() => {
    execGhMock.mockReset().mockResolvedValue("");
    execGhJsonMock.mockReset().mockResolvedValue({});
    execGhApiMock.mockReset().mockResolvedValue({});
});

describe("TOOLS registration", () => {
    test("registers exactly the expected tools", () => {
        expect(TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
    });

    test("every tool has a description and an object input schema", () => {
        for (const tool of TOOLS) {
            expect(tool.description, tool.name).toBeTruthy();
            const schema = tool.inputSchema as {
                type: string;
                properties: Record<string, unknown>;
                required?: string[];
            };
            expect(schema.type, tool.name).toBe("object");
            expect(schema.properties, tool.name).toBeTruthy();
        }
    });

    test("every tool schema carries the injected compact parameter", () => {
        for (const tool of TOOLS) {
            const properties = (tool.inputSchema as any).properties;
            expect(properties.compact, tool.name).toMatchObject({
                type: "boolean",
                default: true,
            });
        }
    });

    test("compact is never required", () => {
        for (const tool of TOOLS) {
            const required = (tool.inputSchema as any).required ?? [];
            expect(required, tool.name).not.toContain("compact");
        }
    });

    test("required arguments survive the compact injection", () => {
        const required = Object.fromEntries(
            TOOLS.map((t) => [t.name, (t.inputSchema as any).required])
        );
        expect(required["get_commit"]).toEqual(["owner", "repo", "sha"]);
        expect(required["pull_request_read"]).toEqual([
            "owner",
            "repo",
            "pullNumber",
            "method",
        ]);
        expect(required["search_code"]).toEqual(["query"]);
        expect(required["get_me"]).toEqual([]);
    });
});

describe("handleToolCall dispatch", () => {
    test("throws for unknown tool names", async () => {
        await expect(handleToolCall("not_a_tool", {})).rejects.toThrow(
            "Unknown tool: not_a_tool"
        );
    });
});

describe("commit tools", () => {
    test("get_commit validates required args", async () => {
        await expect(
            handleToolCall("get_commit", { owner: "o", repo: "r" })
        ).rejects.toThrow("owner, repo, and sha are required");
    });

    test("get_commit hits the commit endpoint", async () => {
        execGhApiMock.mockResolvedValue({ sha: "abc", files: [{ filename: "a" }] });

        const result = await handleToolCall("get_commit", {
            owner: "o",
            repo: "r",
            sha: "abc123",
        });

        expect(execGhApiMock).toHaveBeenCalledWith("/repos/o/r/commits/abc123");
        expect(result).toEqual({ sha: "abc", files: [{ filename: "a" }] });
    });

    test("get_commit strips files when include_diff is false", async () => {
        execGhApiMock.mockResolvedValue({ sha: "abc", files: [{ filename: "a" }] });

        const result = await handleToolCall("get_commit", {
            owner: "o",
            repo: "r",
            sha: "abc123",
            include_diff: false,
        });

        expect(result).toEqual({ sha: "abc" });
    });

    test("list_commits validates required args", async () => {
        await expect(handleToolCall("list_commits", { owner: "o" })).rejects.toThrow(
            "owner and repo are required"
        );
    });

    test("list_commits paginates and encodes sha/author filters", async () => {
        await handleToolCall("list_commits", {
            owner: "o",
            repo: "r",
            sha: "feature/x y",
            author: "a@b.c",
            page: 2,
            perPage: 50,
        });

        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/commits?per_page=50&page=2&sha=feature%2Fx%20y&author=a%40b.c"
        );
    });

    test("list_commits defaults to page 1, 30 per page", async () => {
        await handleToolCall("list_commits", { owner: "o", repo: "r" });

        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/commits?per_page=30&page=1"
        );
    });
});

describe("file tools", () => {
    test("get_file_contents validates required args", async () => {
        await expect(
            handleToolCall("get_file_contents", { owner: "o" })
        ).rejects.toThrow("owner and repo are required");
    });

    test("strips a leading slash from path and applies ref", async () => {
        execGhApiMock.mockResolvedValue({ type: "dir" });

        await handleToolCall("get_file_contents", {
            owner: "o",
            repo: "r",
            path: "/src/index.ts",
            ref: "main",
        });

        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/contents/src/index.ts?ref=main"
        );
    });

    test("sha takes precedence over ref", async () => {
        execGhApiMock.mockResolvedValue({ type: "dir" });

        await handleToolCall("get_file_contents", {
            owner: "o",
            repo: "r",
            path: "README.md",
            ref: "main",
            sha: "abc123",
        });

        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/contents/README.md?ref=abc123"
        );
    });

    test("decodes base64 file content and drops redundant fields", async () => {
        execGhApiMock.mockResolvedValue({
            type: "file",
            content: Buffer.from("hello file").toString("base64"),
            encoding: "base64",
            _links: { self: "x" },
            url: "api-url",
            git_url: "git-url",
            download_url: "dl-url",
            html_url: "https://github.com/o/r/blob/main/f",
        });

        const result = (await handleToolCall("get_file_contents", {
            owner: "o",
            repo: "r",
            path: "f",
        })) as Record<string, unknown>;

        expect(result.decoded_content).toBe("hello file");
        expect(result.content).toBeUndefined();
        expect(result.encoding).toBeUndefined();
        expect(result._links).toBeUndefined();
        expect(result.url).toBeUndefined();
        expect(result.git_url).toBeUndefined();
        expect(result.download_url).toBeUndefined();
        expect(result.html_url).toBe("https://github.com/o/r/blob/main/f");
    });

    test("leaves directory listings undecoded", async () => {
        const listing = [{ name: "a.ts" }, { name: "b.ts" }];
        execGhApiMock.mockResolvedValue(listing);

        const result = await handleToolCall("get_file_contents", {
            owner: "o",
            repo: "r",
        });

        expect(execGhApiMock).toHaveBeenCalledWith("/repos/o/r/contents/");
        expect(result).toEqual(listing);
    });
});

describe("user tools", () => {
    test("get_me hits /user", async () => {
        await handleToolCall("get_me", {});
        expect(execGhApiMock).toHaveBeenCalledWith("/user");
    });

    test("get_teams without user hits /user/teams", async () => {
        await handleToolCall("get_teams", {});
        expect(execGhApiMock).toHaveBeenCalledWith("/user/teams");
    });

    test("get_teams with user falls back to that user's orgs", async () => {
        await handleToolCall("get_teams", { user: "octocat" });
        expect(execGhApiMock).toHaveBeenCalledWith("/users/octocat/orgs");
    });

    test("get_team_members validates required args", async () => {
        await expect(
            handleToolCall("get_team_members", { org: "acme" })
        ).rejects.toThrow("org and team_slug are required");
    });

    test("get_team_members hits the team members endpoint", async () => {
        await handleToolCall("get_team_members", {
            org: "acme",
            team_slug: "core",
        });
        expect(execGhApiMock).toHaveBeenCalledWith(
            "/orgs/acme/teams/core/members"
        );
    });
});

describe("branch tools", () => {
    test("list_branches validates required args", async () => {
        await expect(handleToolCall("list_branches", {})).rejects.toThrow(
            "owner and repo are required"
        );
    });

    test("list_branches paginates", async () => {
        await handleToolCall("list_branches", {
            owner: "o",
            repo: "r",
            page: 3,
            perPage: 10,
        });
        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/branches?per_page=10&page=3"
        );
    });
});

describe("pull request tools", () => {
    test("list_pull_requests validates required args", async () => {
        await expect(
            handleToolCall("list_pull_requests", { owner: "o" })
        ).rejects.toThrow("owner and repo are required");
    });

    test("list_pull_requests builds gh pr list args with defaults", async () => {
        await handleToolCall("list_pull_requests", { owner: "o", repo: "r" });

        expect(execGhJsonMock).toHaveBeenCalledTimes(1);
        const args = execGhJsonMock.mock.calls[0][0];
        expect(args.slice(0, 6)).toEqual([
            "pr",
            "list",
            "--repo",
            "o/r",
            "--state",
            "open",
        ]);
        expect(args).toContain("--limit");
        expect(args).toContain("30");
        expect(args).not.toContain("--head");
        expect(args).not.toContain("--base");
    });

    test("list_pull_requests forwards state, head and base filters", async () => {
        await handleToolCall("list_pull_requests", {
            owner: "o",
            repo: "r",
            state: "closed",
            head: "feature",
            base: "main",
        });

        const args = execGhJsonMock.mock.calls[0][0];
        expect(args).toContain("closed");
        expect(args).toContain("--head");
        expect(args).toContain("feature");
        expect(args).toContain("--base");
        expect(args).toContain("main");
    });

    test("pull_request_read validates required args", async () => {
        await expect(
            handleToolCall("pull_request_read", {
                owner: "o",
                repo: "r",
                pullNumber: 1,
            })
        ).rejects.toThrow("owner, repo, pullNumber, and method are required");
    });

    test("pull_request_read rejects unknown methods", async () => {
        await expect(
            handleToolCall("pull_request_read", {
                owner: "o",
                repo: "r",
                pullNumber: 1,
                method: "get_everything",
            })
        ).rejects.toThrow("Unknown method: get_everything");
    });

    test("method get uses gh pr view", async () => {
        await handleToolCall("pull_request_read", {
            owner: "o",
            repo: "r",
            pullNumber: 42,
            method: "get",
        });

        const args = execGhJsonMock.mock.calls[0][0];
        expect(args.slice(0, 3)).toEqual(["pr", "view", "42"]);
        expect(args).toContain("--repo");
        expect(args).toContain("o/r");
    });

    test("method get_diff wraps raw diff output", async () => {
        execGhMock.mockResolvedValue("diff --git a/x b/x");

        const result = await handleToolCall("pull_request_read", {
            owner: "o",
            repo: "r",
            pullNumber: 42,
            method: "get_diff",
        });

        expect(execGhMock).toHaveBeenCalledWith([
            "pr",
            "diff",
            "42",
            "--repo",
            "o/r",
        ]);
        expect(result).toEqual({ diff: "diff --git a/x b/x" });
    });

    test("method get_status resolves head SHA first, then queries status", async () => {
        execGhJsonMock.mockResolvedValue({ headRefOid: "deadbeef" });
        execGhApiMock.mockResolvedValue({ state: "success" });

        const result = await handleToolCall("pull_request_read", {
            owner: "o",
            repo: "r",
            pullNumber: 42,
            method: "get_status",
        });

        expect(execGhJsonMock.mock.calls[0][0]).toContain("headRefOid");
        expect(execGhApiMock).toHaveBeenCalledWith(
            "/repos/o/r/commits/deadbeef/status"
        );
        expect(result).toEqual({ state: "success" });
    });

    test.each([
        ["get_files", "/repos/o/r/pulls/42/files?per_page=30&page=1"],
        ["get_review_comments", "/repos/o/r/pulls/42/comments?per_page=30&page=1"],
        ["get_reviews", "/repos/o/r/pulls/42/reviews?per_page=30&page=1"],
        ["get_comments", "/repos/o/r/issues/42/comments?per_page=30&page=1"],
    ])("method %s hits %s", async (method, endpoint) => {
        await handleToolCall("pull_request_read", {
            owner: "o",
            repo: "r",
            pullNumber: 42,
            method,
        });

        expect(execGhApiMock).toHaveBeenCalledWith(endpoint);
    });
});

describe("search tools", () => {
    test.each([
        ["search_code"],
        ["search_pull_requests"],
        ["search_repositories"],
        ["search_users"],
    ])("%s requires query", async (tool) => {
        await expect(handleToolCall(tool, {})).rejects.toThrow(
            "query is required"
        );
    });

    test("search_code builds gh search code args", async () => {
        await handleToolCall("search_code", { query: "needle", perPage: 5 });

        const args = execGhJsonMock.mock.calls[0][0];
        expect(args.slice(0, 3)).toEqual(["search", "code", "needle"]);
        expect(args).toContain("--limit");
        expect(args).toContain("5");
    });

    test("search_pull_requests scopes the query with repo qualifier", async () => {
        await handleToolCall("search_pull_requests", {
            query: "fix bug",
            owner: "o",
            repo: "r",
            sort: "created",
            order: "desc",
        });

        const args = execGhJsonMock.mock.calls[0][0];
        expect(args[2]).toBe("repo:o/r fix bug");
        expect(args).toContain("--sort");
        expect(args).toContain("created");
        expect(args).toContain("--order");
        expect(args).toContain("desc");
    });

    test("search_repositories requests minimal fields by default", async () => {
        await handleToolCall("search_repositories", { query: "cli" });

        const args = execGhJsonMock.mock.calls[0][0];
        const jsonFields = args[args.indexOf("--json") + 1];
        expect(jsonFields).toBe(
            "fullName,description,url,stargazersCount,forksCount,language"
        );
    });

    test("search_repositories expands fields when minimal_output is false", async () => {
        await handleToolCall("search_repositories", {
            query: "cli",
            minimal_output: false,
        });

        const args = execGhJsonMock.mock.calls[0][0];
        const jsonFields = args[args.indexOf("--json") + 1];
        expect(jsonFields).toContain("createdAt");
        expect(jsonFields).toContain("license");
    });

    test("search_users uses the REST search endpoint with encoding and sort", async () => {
        await handleToolCall("search_users", {
            query: "type:user berlin",
            sort: "followers",
            order: "asc",
            page: 2,
            perPage: 10,
        });

        expect(execGhApiMock).toHaveBeenCalledWith(
            "/search/users?q=type%3Auser%20berlin&per_page=10&page=2&sort=followers&order=asc"
        );
    });
});
