import { ExecResult } from "./exec-utils.js";
import { TextContent } from "@modelcontextprotocol/server";

/**
 * v1's TextContent schema was a passthrough object, so the out-of-spec `name`
 * label this server attaches type-checked against it directly. v2 closes the
 * type, so the label needs a type of its own. It is load-bearing rather than
 * decorative: it is the only thing distinguishing STDOUT from STDERR from
 * EXIT_CODE inside one content array, and the integration tests assert it.
 */
export type LabeledTextContent = TextContent & { name?: string };

/**
 * Converts an ExecResult into an array of TextContent messages.
 */
export function messagesFor(result: ExecResult): LabeledTextContent[] {
    const messages: LabeledTextContent[] = [];

    if (result.code !== undefined) {
        messages.push({
            type: "text",
            text: `${result.code}`,
            name: "EXIT_CODE",
        });
    }

    // PRN any situation where I want to pass .message and/or .cmd?
    // maybe on errors I should? that way there's a chance to make sure the command was as intended
    // and maybe include message when it doesn't contain stderr?
    // FYI if I put these back, start with tests first

    if (result.signal) {
        messages.push({
            type: "text",
            text: `Signal: ${result.signal}`,
            name: "SIGNAL",
        });
    }
    if (!!result.killed) {
        messages.push({
            type: "text",
            text: "Process was killed",
            name: "KILLED",
        });
    }

    if (result.stdout) {
        messages.push({
            type: "text",
            text: result.stdout,
            name: "STDOUT",
        });
    }
    if (result.stderr) {
        messages.push({
            type: "text",
            text: result.stderr,
            name: "STDERR",
        });
    }
    return messages;
}
