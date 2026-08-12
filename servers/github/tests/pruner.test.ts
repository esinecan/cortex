import { describe, expect, test } from "vitest";
import { pruneResponse, measurePruning } from "../src/core/pruner.js";

describe("pruneResponse", () => {
    test("passes primitives, null and undefined through unchanged", () => {
        expect(pruneResponse(null)).toBeNull();
        expect(pruneResponse(undefined)).toBeUndefined();
        expect(pruneResponse(42)).toBe(42);
        expect(pruneResponse("text")).toBe("text");
        expect(pruneResponse(false)).toBe(false);
    });

    test("recurses through arrays", () => {
        const pruned = pruneResponse([{ node_id: "x", title: "keep" }, 1]);
        expect(pruned).toEqual([{ title: "keep" }, 1]);
    });

    test("strips global bloat fields at any depth", () => {
        const pruned = pruneResponse({
            title: "PR",
            node_id: "abc",
            reactions: { "+1": 0 },
            nested: {
                avatar_url: "http://x",
                url: "api",
                commit_url: "api2",
                sha: "keep-me",
            },
        }) as any;

        expect(pruned).toEqual({
            title: "PR",
            nested: { sha: "keep-me" },
        });
    });

    test("reduces user objects to login and type", () => {
        const pruned = pruneResponse({
            user: {
                login: "octocat",
                type: "User",
                id: 1,
                followers_url: "http://x",
                site_admin: false,
            },
        }) as any;

        expect(pruned.user).toEqual({ login: "octocat", type: "User" });
    });

    test("does not treat non-user objects with a login-like shape as users", () => {
        // login must be a string AND the object must look like a GitHub actor
        const pruned = pruneResponse({ login: "x", custom: "kept" }) as any;
        expect(pruned).toEqual({ login: "x", custom: "kept" });
    });

    test("removes coderabbit state markers from bodies", () => {
        const pruned = pruneResponse({
            body: "Real comment <!-- DwQgtGAEAqAWCWBnSTIEMB26CuAXA9mAAcgLpJrOgBnGArAlIB0w --> text",
        }) as any;

        expect(pruned.body).toBe("Real comment  text");
    });

    test("replaces coderabbit walkthrough blocks with a placeholder", () => {
        const pruned = pruneResponse({
            body: "Intro\n<!-- walkthrough_start -->lots of generated prose<!-- walkthrough_end -->\nOutro",
        }) as any;

        expect(pruned.body).toBe("Intro\n[walkthrough removed]\nOutro");
    });

    test("drops body entirely when sanitization leaves nothing", () => {
        const pruned = pruneResponse({
            id: 1,
            body: "<!-- tips_start -->tips<!-- tips_end -->",
        }) as any;

        expect(pruned.id).toBe(1);
        expect(pruned).not.toHaveProperty("body");
    });

    test("collapses runs of blank lines in bodies", () => {
        const pruned = pruneResponse({
            body: "para one\n\n\n\n\npara two",
        }) as any;

        expect(pruned.body).toBe("para one\n\npara two");
    });
});

describe("measurePruning", () => {
    test("reports sizes and percentage reduction", () => {
        const original = { a: "x".repeat(100), node_id: "y".repeat(100) };
        const pruned = pruneResponse(original);
        const stats = measurePruning(original, pruned);

        expect(stats.originalSize).toBeGreaterThan(stats.prunedSize);
        expect(stats.reduction).toMatch(/^\d+(\.\d+)?%$/);
    });
});
