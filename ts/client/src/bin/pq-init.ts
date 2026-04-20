#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import { parseArgs } from "node:util";
import * as toml from "smol-toml";

import { PiquedMigrationToml } from "../upgrade-control/control.js";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate init <upgrade dir>
Description:
    Initializes a new piqued migration directory. This will create the directory if it does not exist, and will add in the root migration.
Options:
    -h, --help        Show this help message
`);
};

export const dispatchInit = async (argv: string[]) => {
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

    const [directory] = positionals;
    if (!directory || values.help) {
        help();
        process.exit(0);
    }

    await pqInit(directory);
};

export const pqInit = async (directory: string) => {
    const version = "root#000000";
    const rootUpgradeDir = pathMod.join(directory, version);

    await fs.mkdir(rootUpgradeDir, { recursive: true });

    const upgradeSql = ` -- File: upgrade.sql
 -- Version: ${version}
 -- Parents: []

 -- This is the root migration. It should be empty, and serves as the common ancestor for all other migrations.
`;
    const downgradeSql = ` -- File: downgrade.sql
 -- Version: ${version}
 -- Parents: []

 -- This is the root migration. It should be empty, and serves as the common ancestor for all other migrations.
`;

    const options: PiquedMigrationToml = {
        version: version,
        isolatedTx: false,
        parents: [],
    };

    const optionsToml = toml.stringify(options);

    const baseDir = rootUpgradeDir;
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(pathMod.join(baseDir, "upgrade.sql"), upgradeSql, { encoding: "utf8" });
    await fs.writeFile(pathMod.join(baseDir, "downgrade.sql"), downgradeSql, { encoding: "utf8" });
    await fs.writeFile(pathMod.join(baseDir, "migration.toml"), optionsToml, { encoding: "utf8" });

    process.stdout.write(baseDir);
    process.stdout.write("\n");
};
