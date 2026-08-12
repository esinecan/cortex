import { describe, expect, test } from "vitest";
import { presentResponse } from "../src/core/presenters.js";

describe("presentResponse", () => {
    test("returns data unchanged for tools without a presenter", () => {
        const data = { anything: true };
        expect(presentResponse("get_file_contents", data)).toBe(data);
        expect(presentResponse("search_code", data)).toBe(data);
    });

    describe("list_commits", () => {
        test("compacts each commit to sha7/message-first-line/author/date/url", () => {
            const raw = [
                {
                    sha: "0123456789abcdef",
                    html_url: "https://github.com/o/r/commit/0123456",
                    commit: {
                        message: "feat: subject line\n\nlong body",
                        author: { name: "Alice", date: "2026-01-02T03:04:05Z" },
                    },
                    author: { login: "alice" },
                },
            ];

            expect(presentResponse("list_commits", raw)).toEqual([
                {
                    sha: "0123456",
                    message: "feat: subject line",
                    author: "Alice",
                    date: "2026-01-02T03:04:05Z",
                    url: "https://github.com/o/r/commit/0123456",
                },
            ]);
        });

        test("falls back to author login when commit author name is missing", () => {
            const raw = [
                {
                    sha: "0123456789abcdef",
                    commit: { message: "m", author: {} },
                    author: { login: "bob" },
                },
            ];
            const presented = presentResponse("list_commits", raw) as any[];
            expect(presented[0].author).toBe("bob");
        });

        test("passes non-array data through", () => {
            const notAList = { message: "not found" };
            expect(presentResponse("list_commits", notAList)).toBe(notAList);
        });
    });

    describe("get_commit", () => {
        test("includes stats and files when present", () => {
            const raw = {
                sha: "0123456789abcdef",
                html_url: "u",
                commit: {
                    message: "full message",
                    author: { name: "Alice", date: "d" },
                },
                stats: { additions: 3, deletions: 1, total: 4, extra: "dropped" },
                files: [
                    {
                        filename: "a.ts",
                        status: "modified",
                        additions: 3,
                        deletions: 1,
                        patch: "@@",
                        sha: "dropped",
                    },
                ],
            };

            expect(presentResponse("get_commit", raw)).toEqual({
                sha: "0123456",
                message: "full message",
                author: "Alice",
                date: "d",
                url: "u",
                stats: { additions: 3, deletions: 1, total: 4 },
                files: [
                    {
                        filename: "a.ts",
                        status: "modified",
                        additions: 3,
                        deletions: 1,
                        patch: "@@",
                    },
                ],
            });
        });

        test("passes data without a sha through", () => {
            const raw = { error: "whatever" };
            expect(presentResponse("get_commit", raw)).toBe(raw);
        });
    });

    describe("list_branches", () => {
        test("compacts branches to name/protected/sha7", () => {
            const raw = [
                {
                    name: "main",
                    protected: true,
                    commit: { sha: "0123456789abcdef" },
                    _links: { self: "dropped" },
                },
            ];

            expect(presentResponse("list_branches", raw)).toEqual([
                { name: "main", protected: true, sha: "0123456" },
            ]);
        });
    });

    describe("search_users", () => {
        test("compacts the items array and keeps total_count", () => {
            const raw = {
                total_count: 2,
                incomplete_results: false,
                items: [
                    { login: "a", type: "User", html_url: "ua", score: 1 },
                    { login: "b", type: "Organization", html_url: "ub", score: 1 },
                ],
            };

            expect(presentResponse("search_users", raw)).toEqual({
                total_count: 2,
                items: [
                    { login: "a", type: "User", url: "ua" },
                    { login: "b", type: "Organization", url: "ub" },
                ],
            });
        });

        test("passes responses without items through", () => {
            const raw = { message: "rate limited" };
            expect(presentResponse("search_users", raw)).toBe(raw);
        });
    });

    describe("pull_request_read", () => {
        test("without a method arg the data passes through", () => {
            const raw = [{ anything: 1 }];
            expect(presentResponse("pull_request_read", raw)).toBe(raw);
        });

        test("get and get_diff pass through", () => {
            const raw = { diff: "diff --git" };
            expect(
                presentResponse("pull_request_read", raw, { method: "get_diff" })
            ).toBe(raw);
        });

        test("get_files compacts changed files", () => {
            const raw = [
                {
                    filename: "a.ts",
                    status: "added",
                    additions: 1,
                    deletions: 0,
                    patch: "@@",
                    blob_url: "dropped",
                },
            ];

            expect(
                presentResponse("pull_request_read", raw, { method: "get_files" })
            ).toEqual([
                {
                    filename: "a.ts",
                    status: "added",
                    additions: 1,
                    deletions: 0,
                    patch: "@@",
                },
            ]);
        });

        test("get_review_comments keeps path/line only for review comments", () => {
            const raw = [
                {
                    id: 1,
                    user: { login: "alice" },
                    body: "review note",
                    created_at: "c",
                    updated_at: "u",
                    path: "src/x.ts",
                    line: 12,
                    html_url: "link",
                },
                {
                    id: 2,
                    user: { login: "bob" },
                    body: "issue comment",
                    created_at: "c",
                    updated_at: "u",
                    html_url: "link2",
                },
            ];

            const presented = presentResponse("pull_request_read", raw, {
                method: "get_review_comments",
            }) as any[];

            expect(presented[0]).toEqual({
                id: 1,
                user: "alice",
                body: "review note",
                created_at: "c",
                updated_at: "u",
                path: "src/x.ts",
                line: 12,
                url: "link",
            });
            expect(presented[1]).not.toHaveProperty("path");
        });

        test("get_reviews compacts review objects", () => {
            const raw = [
                {
                    id: 9,
                    user: { login: "alice" },
                    state: "APPROVED",
                    body: "lgtm",
                    submitted_at: "s",
                    commit_id: "dropped",
                },
            ];

            expect(
                presentResponse("pull_request_read", raw, { method: "get_reviews" })
            ).toEqual([
                {
                    id: 9,
                    user: "alice",
                    state: "APPROVED",
                    body: "lgtm",
                    submitted_at: "s",
                },
            ]);
        });

        test("get_status compacts combined status", () => {
            const raw = {
                state: "success",
                total_count: 1,
                sha: "dropped",
                statuses: [
                    {
                        context: "ci/build",
                        state: "success",
                        description: "ok",
                        target_url: "t",
                        id: 123,
                    },
                ],
            };

            expect(
                presentResponse("pull_request_read", raw, { method: "get_status" })
            ).toEqual({
                state: "success",
                total_count: 1,
                statuses: [
                    {
                        context: "ci/build",
                        state: "success",
                        description: "ok",
                        target_url: "t",
                    },
                ],
            });
        });
    });
});
