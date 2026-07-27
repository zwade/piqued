import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    resolve: {
        // Test against source rather than requiring a build first.
        alias: {
            "@piqued/client": resolve("../client/src/index.ts"),
            "@piqued/liveview": resolve("../liveview/src/index.ts"),
        },
    },
    test: {
        globals: true,
        include: ["src/**/*.test.ts"],
    },
});
