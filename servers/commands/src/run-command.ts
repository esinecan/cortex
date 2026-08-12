import { exec, ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import { CallToolResult } from "@modelcontextprotocol/server";
import { execFileWithInput, ExecResult } from "./exec-utils.js";
import { always_log } from "./always_log.js";
import { LabeledTextContent, messagesFor } from "./messages.js";
import { ObjectEncodingOptions } from "node:fs";

const execAsync = promisify(exec);

async function execute(command: string, stdin: string, options: ExecOptions) {
    // PRN merge calls to exec into one single paradigm with conditional STDIN handled in one spot?
    //   right now no STDIN => exec directly and let it throw to catch failures
    //   w/ STDIN => you manually glue together callbacks + promises (i.e. reject)
    //     feels sloppy to say the least, notably the error handling with ExecExeption error that has stdin/stderr on it
    if (!stdin) {
        return await execAsync(command, options);
    }
    return await execFileWithInput(command, stdin, options);
}

/**
 * v2 types CallToolResult.content as a discriminated union of content blocks,
 * so callers can no longer read .text off an element without narrowing, and
 * .name is not on it at all. This server only ever emits labelled text, so it
 * says so: the result stays assignable to CallToolResult while the integration
 * tests keep reading .text and .name directly.
 */
export type RunCommandResult = Omit<CallToolResult, "content"> & {
    content: LabeledTextContent[];
};

/**
 * Executes a command and returns the result as CallToolResult.
 */
export type RunCommandArgs = Record<string, unknown> | undefined;
export async function runCommand(args: RunCommandArgs): Promise<RunCommandResult> {

    const command = args?.command as string;
    if (!command) {
        const message = "Command is required, current value: " + command;
        return {
            isError: true,
            content: [{ type: "text", text: message }],
        };
    }

    const options: ObjectEncodingOptions & ExecOptions = { encoding: "utf8" };
    if (args?.workdir) {
        options.cwd = String(args.workdir);
    }
    if (args?.timeout) {
        options.timeout = Number(args.timeout) * 1000; // seconds to ms
    }

    const stdin = args?.stdin as string;

    try {
        const result = await execute(command, stdin, options);
        return {
            content: messagesFor(result),
        };
    } catch (error) {
        // PRN do I want to differentiate non-command related error (i.e. if messagesFor blows up
        //   or presumably if smth else goes wrong with the node code in exec that isn't command related
        //   if so, write a test first

        // console.log("ERROR_runCommand", error);
        // ExecException (error + stdout/stderr) merged
        // - IIUC this happens on uncaught failures
        // - but if you catch an exec() promise failure (or use exec's callback) => you get separated values: error, stdout, stderr
        // - which is why I mirror this response type in my reject(error) calls
        //
        // 'error' example:
        // code: 127,
        // killed: false,
        // signal: null,
        // cmd: 'nonexistentcommand',
        // stdout: '',
        // stderr: '/bin/sh: nonexistentcommand: command not found\n'

        const response = {
            isError: true,
            content: messagesFor(error as ExecResult),
        };
        always_log("WARN: run_command failed", response);
        return response;
    }
}
