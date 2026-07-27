import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests run against the workspace *sources* rather than the published `dist` output, so that
 * `yarn test` never depends on a prior build. Deep `dist/...` imports (which is how the packages
 * reach each other's non-exported internals) are rewritten to the matching source file.
 */
const packageAlias = (name: string, dir: string) => [
    { find: new RegExp(`^${name}/dist/(.*)\\.js$`), replacement: `${resolve(dir)}/$1.ts` },
    { find: new RegExp(`^${name}$`), replacement: `${resolve(dir)}/index.ts` },
];

export default defineConfig({
    resolve: {
        alias: [...packageAlias("@piqued/client", "../client/src"), ...packageAlias("@piqued/liveview", "../liveview/src")],
    },
    test: {
        globals: true,
        include: ["src/**/*.test.ts"],
    },
});
