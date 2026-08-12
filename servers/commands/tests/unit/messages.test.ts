import { messagesFor } from "../../src/messages.js";
import { ExecResult } from "../../src/exec-utils.js";

describe("messagesFor", () => {
    test("returns empty array when there is nothing to report", () => {
        const result: ExecResult = { stdout: "", stderr: "" };
        expect(messagesFor(result)).toEqual([]);
    });

    test("labels stdout as STDOUT", () => {
        const messages = messagesFor({ stdout: "hi\n", stderr: "" });
        expect(messages).toEqual([
            { type: "text", text: "hi\n", name: "STDOUT" },
        ]);
    });

    test("labels stderr as STDERR", () => {
        const messages = messagesFor({ stdout: "", stderr: "oops\n" });
        expect(messages).toEqual([
            { type: "text", text: "oops\n", name: "STDERR" },
        ]);
    });

    test("puts EXIT_CODE first, before STDOUT and STDERR", () => {
        const messages = messagesFor({
            stdout: "out\n",
            stderr: "err\n",
            code: 2,
        });
        expect(messages.map((m) => m.name)).toEqual([
            "EXIT_CODE",
            "STDOUT",
            "STDERR",
        ]);
        expect(messages[0].text).toBe("2");
    });

    test("includes EXIT_CODE even when the code is 0", () => {
        // the guard is `code !== undefined`, so an explicit 0 is reported
        const messages = messagesFor({ stdout: "", stderr: "", code: 0 });
        expect(messages).toEqual([
            { type: "text", text: "0", name: "EXIT_CODE" },
        ]);
    });

    test("reports SIGNAL and KILLED for a killed process", () => {
        const messages = messagesFor({
            stdout: "",
            stderr: "",
            signal: "SIGTERM",
            killed: true,
        });
        expect(messages).toEqual([
            { type: "text", text: "Signal: SIGTERM", name: "SIGNAL" },
            { type: "text", text: "Process was killed", name: "KILLED" },
        ]);
    });

    test("omits SIGNAL when signal is null and KILLED when killed is false", () => {
        const messages = messagesFor({
            stdout: "done\n",
            stderr: "",
            code: 1,
            signal: undefined,
            killed: false,
        });
        expect(messages.map((m) => m.name)).toEqual(["EXIT_CODE", "STDOUT"]);
    });

    test("every message is a text content block", () => {
        const messages = messagesFor({
            stdout: "a",
            stderr: "b",
            code: 9,
            signal: "SIGKILL",
            killed: true,
        });
        expect(messages).toHaveLength(5);
        for (const message of messages) {
            expect(message.type).toBe("text");
            expect(typeof message.text).toBe("string");
            expect(typeof message.name).toBe("string");
        }
    });
});
