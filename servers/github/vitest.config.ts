import { defineConfig } from "vitest/config";

// vitest instead of jest: the package is NodeNext ESM and the rest of the
// cortex repo already runs vitest, so this keeps the toolchain consistent
// and avoids the ts-jest ESM mocking friction.
export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
    },
});
