#!/usr/bin/env node

import { parseArgs } from "node:util";

import { getConfigPool } from "../config/config-pool.js";
import { PiquedConfig } from "../config/piqued-config.js";
import { PiquedUpgradeControl } from "../upgrade-control/control.js";

const help = () => {
    process.stdout.write(`Usage: piqued-migrate upgrade <upgrade dir> [target] [--allow-downgrade|-d]
Description:
    Upgrades a set of legacy migrations (linear upgrades with no branches) to the new format.
Arguments:
    upgrade dir             The directory containing the migrations
    target                  The target version to upgrade to. If not specified, upgrades to the latest version.
Options:
    -h, --help              Show this help message
    -d, --allow-downgrade   Allow downgrading to an older version (default: false)
    -c, --config            Specify a custom config file
`);
};

export const dispatchUpgrade = async (argv: string[]) => {
    const { values, positionals } = parseArgs({
        options: {
            help: {
                type: "string",
                short: "h",
            },
            allowDowngrade: {
                type: "boolean",
                short: "d",
            },
            config: {
                type: "string",
                short: "c",
            },
        },
        allowPositionals: true,
        args: argv,
    });

    const [directory, target] = positionals;
    if (!directory || values.help) {
        help();
        process.exit(0);
    }

    const workingDirectory = process.cwd();
    const configPath = values.config
        ? await PiquedConfig.findFile(values.config)
        : await PiquedConfig.findDir(workingDirectory);

    if (!configPath) {
        process.stderr.write(
            "Error: Could not find config file. Please specify a config file with --config or run this command in a directory with a `piqued.toml`.\n",
        );

        process.exit(1);
    }

    const config = await PiquedConfig.load(configPath, workingDirectory);
    const control = await PiquedUpgradeControl.fromDir(directory);

    await using pool = getConfigPool(config);
    using client = await pool.checkout();

    await control.upgradeToVersion(client, target, { preventDowngrade: !values.allowDowngrade });
};
