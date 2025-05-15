#!/usr/bin/env node

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import { parseArgs } from "node:util";
import * as toml from "smol-toml";

import { PiquedMigrationToml, PiquedUpgradeControl } from "../upgrade-control/control";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate new <upgrade dir> <new upgrade path>
Description:
    Generates a new migration in the specified directory. The new upgrade path is used to generate the new upgrade name.
Options:
    -h, --help        Show this help message
`);
};

export const dispatchNew = async (argv: string[]) => {
    const { values, positionals } = parseArgs({
        options: {
            help: {
                type: "string",
                short: "h",
            },
        },
        allowPositionals: true,
        args: argv,
    });

    const [directory, newUpgrade] = positionals;
    if (!newUpgrade || !directory || values.help) {
        help();
        process.exit(0);
    }

    await pqNew(directory, newUpgrade);
};

export const pqNew = async (directory: string, newUpgrade: string) => {
    const upgradeControl = await PiquedUpgradeControl.fromDir(directory);
    const graph = upgradeControl.upgradeGraph;
    const asPath = pathMod.parse(newUpgrade);

    const heads = graph.heads.map((x) => graph.get(x)?.version!);

    const shaSuffixHash = crypto.createHash("sha256");
    shaSuffixHash.update(asPath.base);
    shaSuffixHash.update(heads.join("\x00"));
    const shaSuffix = shaSuffixHash.digest("hex").slice(0, 6);

    const upgradeName = asPath.base.replace(/[^a-zA-Z0-9-_]+/g, "-") + "#" + shaSuffix;

    const upgradeSql = ` -- Version: ${upgradeName}
 -- Parents: ${heads.join(", ")}

 -- TODO: Implement upgrade for ${upgradeName}
`;
    const downgradeSql = ` -- TODO: Implement downgrade for ${upgradeName}
`;

    const options: PiquedMigrationToml = {
        version: upgradeName,
        isolatedTx: false,
        parents: heads,
    };

    const optionsToml = toml.stringify(options);

    const baseDir = newUpgrade + "#" + shaSuffix;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(pathMod.join(baseDir, "upgrade.sql"), upgradeSql, { encoding: "utf8" });
    await fs.writeFile(pathMod.join(baseDir, "downgrade.sql"), downgradeSql, { encoding: "utf8" });
    await fs.writeFile(pathMod.join(baseDir, "migration.toml"), optionsToml, { encoding: "utf8" });
};
