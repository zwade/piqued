#!/usr/bin/env node

import { parseArgs } from "node:util";

import { PiquedUpgradeControl } from "../upgrade-control/control";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate legacy-upgrade <upgrade dir>
Description:
    Upgrades a set of legacy migrations (linear upgrades with no branches) to the new format.
Options:
    -h, --help        Show this help message
`);
};

export const dispatchLegacyUpgrade = async (argv: string[]) => {
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

    await PiquedUpgradeControl.migrateUpgradeDir(directory);
};
