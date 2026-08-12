import * as fs from "node:fs";
import * as path from "node:path";
import { execFileWithInput } from "../../src/exec-utils.js";
import {
    describeIfAvailable,
    normalizeEol,
    toBashPath,
} from "../helpers.js";

// FYI these tests exercise the real exec path (no mocks): /bin/sh on POSIX,
// cmd.exe on Windows, with the named interpreter resolved from PATH either
// way. Shell-specific suites are gated on the shell actually being installed;
// on this Windows box bash ships with Git for Windows while zsh/fish are
// normally absent, so those suites skip with an explicit reason instead of
// failing. On a POSIX box with zsh/fish installed every suite runs.

const [describeBash, bashTitle] = describeIfAvailable("bash", "bash");
const [describeZsh, zshTitle] = describeIfAvailable("zsh", "zsh");
const [describeFish, fishTitle] = describeIfAvailable("fish", "fish");

describe("execFileWithInput integration tests", () => {
    describeBash(bashTitle, () => {
        test("should execute a simple bash command", async () => {
            const result = await execFileWithInput(
                "bash",
                'echo "Hello World"',
                {}
            );
            expect(result.stdout).toBe("Hello World\n");
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });

        test("should handle command errors properly in bash", async () => {
            try {
                await execFileWithInput("bash", "nonexistentcommand", {});
                fail("Should have thrown an error");
            } catch (result: any) {
                // FYI catch is so you can run assertions on the failed result, given the promise is rejected, it's then thrown here
                const expected_stderr =
                    "bash: line 1: nonexistentcommand: command not found";
                expect(result.stderr).toContain(expected_stderr);
                const expected_message =
                    "Command failed: bash\n" + expected_stderr + "\n";
                expect(result.message).toContain(expected_message);
                expect(result.code).toBe(127);
            }
        });

        test("should handle bash multiline scripts", async () => {
            const stdin = `
      echo "Line 1"
      echo "Line 2"
      echo "Line 3"
    `;
            const result = await execFileWithInput("bash", stdin, {});
            expect(result.stdout).toContain(`Line 1
Line 2
Line 3`);
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });

        test("should capture stderr without failing when exit code is 0", async () => {
            const result = await execFileWithInput(
                "bash",
                'echo "to stdout"; echo "to stderr" 1>&2',
                {}
            );
            expect(result.stdout).toBe("to stdout\n");
            expect(result.stderr).toBe("to stderr\n");
            expect(result.code).toBeUndefined();
        });

        test("should reject with stdout, stderr and exit code on failure", async () => {
            try {
                await execFileWithInput(
                    "bash",
                    'echo "partial output"; echo "the error" 1>&2; exit 3',
                    {}
                );
                fail("Should have thrown an error");
            } catch (result: any) {
                // the reject path mirrors ExecException: output is attached to the error
                expect(result.stdout).toBe("partial output\n");
                expect(result.stderr).toBe("the error\n");
                expect(result.code).toBe(3);
                expect(result.killed).toBe(false);
            }
        });

        test("should respect working directory option", async () => {
            // Use this test's own directory instead of "/": it exists on every
            // platform, and on Windows bash prints it in MSYS form (/c/...),
            // which toBashPath reproduces deterministically.
            // jest runs with cwd at the package root
            const workdir = fs.realpathSync(path.join(process.cwd(), "tests"));
            const result = await execFileWithInput("bash", "pwd", {
                cwd: workdir,
            });
            expect(normalizeEol(result.stdout)).toBe(toBashPath(workdir) + "\n");
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });

        test("should skip the stdin write branch when stdin is empty", async () => {
            // covers the `if (stdin)` false path: command runs, nothing piped
            const result = await execFileWithInput(
                'bash -c "echo no-stdin-needed"',
                "",
                {}
            );
            expect(result.stdout).toBe("no-stdin-needed\n");
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });
    });

    describeZsh(zshTitle, () => {
        test("should execute zsh command", async () => {
            const result = await execFileWithInput(
                "zsh",
                'echo "Hello from Zsh"',
                {}
            );
            expect(result.stdout).toBe("Hello from Zsh\n");
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });

        test("should handle command errors properly in zsh", async () => {
            try {
                await execFileWithInput(
                    "zsh",
                    "completelynonexistentcommand",
                    {}
                );
                fail("Should have thrown an error");
            } catch (result: any) {
                const expected_stderr =
                    "zsh: command not found: completelynonexistentcommand";
                expect(result.stderr).toContain(expected_stderr);
                const expected_message =
                    "Command failed: zsh\n" + expected_stderr + "\n";
                expect(result.message).toBe(expected_message);
                expect(result.code).toBe(127);
                expect(result.killed).toBe(false);
                expect(result.signal).toBeNull();
            }
        });

        test("should handle multiline scripts in zsh", async () => {
            const stdin = `
      echo "Line 1 from Zsh"
      for i in 1 2 3; do
        echo "Number $i"
      done
    `;
            const result = await execFileWithInput("zsh", stdin, {});
            expect(result.stdout).toContain(`Line 1 from Zsh
Number 1
Number 2
Number 3
`);
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });
    });

    describeFish(fishTitle, () => {
        // These cover the fishWorkaround base64 path in exec-utils.ts
        test("should handle fish shell command", async () => {
            const result = await execFileWithInput(
                "fish",
                'echo "Hello from Fish"',
                {}
            );
            expect(result.stdout).toBe("Hello from Fish\n");
            expect(result.stderr).toBe("");
            expect(result.code).toBeUndefined();
        });

        test("should handle command errors properly in fish", async () => {
            try {
                await execFileWithInput(
                    "fish",
                    "totallynonexistentcommand",
                    {}
                );
                fail("Should have thrown an error");
            } catch (result: any) {
                const expected_stderr =
                    "fish: Unknown command: totallynonexistentcommand\nfish: \ntotallynonexistentcommand\n^~~~~~~~~~~~~~~~~~~~~~~~^";
                expect(result.stderr).toContain(expected_stderr);
                const expected_message =
                    'Command failed: fish -c "echo dG90YWxseW5vbmV4aXN0ZW50Y29tbWFuZA== | base64 -d | fish"' +
                    "\n" +
                    expected_stderr;
                expect(result.message).toContain(expected_message);
                expect(result.code).toBe(127);
                expect(result.killed).toBe(false);
                expect(result.signal).toBeNull();
            }
        });
    });
});
