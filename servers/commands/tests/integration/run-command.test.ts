import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "../../src/run-command.js";
import { isWindows, normalizeEol } from "../helpers.js";

describe("runCommand", () => {
    // FYI! these are integration tests only (test the glue)
    //   put all execution validations into lower level exec functions
    //   this is just to provide assertions that runCommand wires things together correctly
    //
    // Commands run through node's exec: /bin/sh on POSIX, cmd.exe on Windows.
    // Where the two disagree (exit codes, error text, CRLF) the assertions are
    // platform-aware rather than skipped. `node` is used as the workhorse
    // command because it is guaranteed present (it is running this test) and
    // behaves identically on both platforms.

    // FYI any uses of always_log will trigger warnings if using console.error!
    //    that's fine and to be expected... tests still pass...

    describe("when command is successful", () => {
        const request = runCommand({
            command: `node -e "console.log('Hello World')"`,
        });

        test("should not set isError", async () => {
            const result = await request;

            expect(result.isError).toBeUndefined();

            // *** tool response format  (isError only set if failure)
            //  https://modelcontextprotocol.io/docs/concepts/tools#error-handling-2
        });

        test("should include STDOUT from command", async () => {
            const result = await request;

            expect(result.content).toHaveLength(1);
            const stdout = result.content[0];
            expect(stdout.text).toBe("Hello World\n");
            // the non-spec label is load-bearing for this server; in-process
            // it is visible even though v2 clients strip it on the wire
            expect(stdout.name).toBe("STDOUT");
        });
    });

    test("should change working directory based on workdir arg", async () => {
        const targetDir = fs.realpathSync(path.join(process.cwd(), "tests"));
        const printCwd = `node -e "console.log(process.cwd())"`;

        // * ensure the default cwd is not already the target dir
        const defaultResult = await runCommand({ command: printCwd });
        expect(defaultResult.isError).toBeUndefined();
        expect(defaultResult.content).toHaveLength(1);
        const defaultStdout = defaultResult.content[0];
        expect(defaultStdout.name).toBe("STDOUT");
        expect(defaultStdout.text.trim()).not.toBe(targetDir);

        // * test setting workdir
        const result = await runCommand({
            command: printCwd,
            workdir: targetDir,
        });
        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        const resultStdout = result.content[0];
        expect(resultStdout.name).toBe("STDOUT");
        expect(fs.realpathSync(resultStdout.text.trim())).toBe(targetDir);
    });

    test("should return isError and STDERR on a failure (nonexistentcommand)", async () => {
        const result = await runCommand({
            command: "nonexistentcommand",
        });

        expect(result.isError).toBe(true);

        expect(result.content).toHaveLength(2);

        // FYI keep EXIT_CODE first, feels appropriate
        //  do not put it after STDOUT/STDERR where it might be missed by me (when I do log reviews)
        //  also I think its best for the model to see it first/early
        const exit_code = result.content[0];
        // POSIX shells report 127 for command-not-found; cmd.exe reports 1
        expect(exit_code.text).toContain(isWindows ? "1" : "127");
        expect(exit_code.name).toContain("EXIT_CODE");

        const stderr = result.content[1];
        if (isWindows) {
            // cmd.exe: 'nonexistentcommand' is not recognized as an internal or external command...
            expect(stderr.text).toMatch(
                /nonexistentcommand.*not recognized/i
            );
        } else {
            // /bin/sh: nonexistentcommand: command not found (wording varies by sh flavor)
            expect(stderr.text).toMatch(/nonexistentcommand.*not found/i);
        }
        expect(stderr.name).toContain("STDERR");
    });

    test("should report both STDOUT and STDERR alongside EXIT_CODE on failure", async () => {
        const script =
            "console.log('the stdout'); console.error('the stderr'); process.exit(3)";
        const result = await runCommand({
            command: `node -e "${script}"`,
        });

        expect(result.isError).toBe(true);
        const names = result.content.map((c) => c.name);
        // EXIT_CODE is deliberately first (see comment above)
        expect(names).toEqual(["EXIT_CODE", "STDOUT", "STDERR"]);
        expect(result.content[0].text).toBe("3");
        expect(result.content[1].text).toBe("the stdout\n");
        expect(result.content[2].text).toBe("the stderr\n");
    });

    test("should capture STDERR without isError when the command succeeds", async () => {
        const result = await runCommand({
            command: `node -e "console.error('just a warning')"`,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(result.content[0].name).toBe("STDERR");
        expect(result.content[0].text).toBe("just a warning\n");
    });

    test("should handle missing command parameter", async () => {
        const result = await runCommand({});

        expect(result.isError).toBe(true);

        const firstMessage = result.content[0];
        expect(firstMessage.text).toContain(
            "Command is required, current value: undefined"
        );
    });

    test("should treat an empty command string as missing", async () => {
        const result = await runCommand({ command: "" });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Command is required");
    });

    test("should handle undefined args", async () => {
        const result = await runCommand(undefined);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Command is required");
    });

    test("should return isError for a nonexistent workdir", async () => {
        const result = await runCommand({
            command: `node -e "console.log('never runs')"`,
            workdir: path.join(process.cwd(), "definitely-not-a-real-dir"),
        });

        expect(result.isError).toBe(true);
    });

    test("should kill command that exceeds timeout", async () => {
        const result = await runCommand({
            command: `node -e "setTimeout(() => {}, 10000)"`, // holds the event loop ~10s
            timeout: 1, // 1 second
        });

        expect(result.isError).toBe(true);

        const names = result.content.map((c) => c.name);
        expect(names).toContain("SIGNAL");
        expect(names).toContain("KILLED");

        const signalMsg = result.content.find((c) => c.name === "SIGNAL")!;
        expect(signalMsg.text).toContain("SIGTERM");

        const killedMsg = result.content.find((c) => c.name === "KILLED")!;
        expect(killedMsg.text).toBe("Process was killed");
    });

    test("should not kill command that finishes within timeout", async () => {
        const result = await runCommand({
            command: `node -e "console.log('fast')"`,
            timeout: 10,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe("fast\n");
    });

    test("should run through the platform shell (normalized line endings)", async () => {
        // unlike the node-based tests above, this exercises the real default
        // shell; cmd.exe emits CRLF, so normalize deliberately
        const result = await runCommand({ command: "echo shell-test" });

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(normalizeEol(result.content[0].text)).toBe("shell-test\n");
    });

    describe("when stdin passed and command succeeds", () => {
        // node executes piped stdin as a script — same interpreter contract
        // the tool documents (e.g. "pass a python script to python3")
        const request = runCommand({
            command: "node",
            stdin: `process.stdout.write("Hello World")`,
        });

        test("should not set isError", async () => {
            const result = await request;

            expect(result.isError).toBeUndefined();
        });

        test("should include STDOUT from command", async () => {
            const result = await request;

            expect(result.content).toHaveLength(1);
            const stdout = result.content[0];
            expect(stdout.text).toBe("Hello World");
            expect(stdout.name).toBe("STDOUT");
        });
    });

    describe("when stdin passed and command fails", () => {
        // covers the execFileWithInput reject path through runCommand's catch
        const request = runCommand({
            command: "node",
            stdin: `console.error("stdin script failed"); process.exit(5)`,
        });

        test("should set isError with EXIT_CODE first and STDERR", async () => {
            const result = await request;

            expect(result.isError).toBe(true);
            const names = result.content.map((c) => c.name);
            expect(names).toEqual(["EXIT_CODE", "STDERR"]);
            expect(result.content[0].text).toBe("5");
            expect(result.content[1].text).toBe("stdin script failed\n");
        });
    });
});
