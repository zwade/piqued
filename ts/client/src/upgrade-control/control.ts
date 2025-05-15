import * as fs from "fs/promises";
import * as pathMod from "path";
import * as toml from "smol-toml";
import { z } from "zod";

import { SmartClient } from "../smart-client.js";
import { Operation, PiquedUpgradeGraph, PiquedUpgradeInstance } from "./upgrade-graph.js";

export type PiquedMigrationToml = {
    version: string;
    parents?: string[];
    isolatedTx?: boolean;
};

export const ZPiquedMigrationToml = z.object({
    version: z.string(),
    parents: z.array(z.string()).optional(),
    isolatedTx: z.boolean().optional(),
});

export class PiquedUpgradeControl {
    #upgrades;

    private static async tryRead(...components: string[]) {
        const filePath = pathMod.join(...components);
        try {
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                console.warn(`At ${filePath}: Found directory but expected file`);
                return undefined;
            }

            const buffer = await fs.readFile(filePath);
            return buffer.toString("utf-8");
        } catch (e) {
            return undefined;
        }
    }

    public static async migrateUpgradeDir(upgradeDir: string) {
        const legacyUpgrades = await fs.readdir(upgradeDir);

        await fs.mkdir(pathMod.join(upgradeDir, "legacy"), { recursive: true });

        // A legacy upgrade is a directory with a single numeric identifier, and no migration.toml
        for (const upgrade of legacyUpgrades) {
            const upgradeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "upgrade.sql");
            const optionsTomlFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "migration.toml");

            if (upgradeFile === undefined) {
                continue;
            }

            if (optionsTomlFile !== undefined) {
                continue;
            }

            const upgradeAsInt = parseInt(upgrade, 10);
            if (isNaN(upgradeAsInt)) {
                console.warn(`Found invalid upgrade: ${upgrade}. Skipping`);
                continue;
            }

            const newOptions: PiquedMigrationToml = {
                version: `legacy_${upgrade}`,
                parents: upgradeAsInt > 1 ? [`legacy_${upgradeAsInt - 1}`] : [],
                isolatedTx: false,
            };

            const newOptionsFilePath = pathMod.join(upgradeDir, upgrade, "migration.toml");
            await fs.writeFile(newOptionsFilePath, toml.stringify(newOptions));
            await fs.rename(pathMod.join(upgradeDir, upgrade), pathMod.join(upgradeDir, "legacy", upgrade));
        }
    }

    public static async fromDir(upgradeLocation: string) {
        const upgradeInstances: PiquedUpgradeInstance[] = [];

        const parsedPath = pathMod.parse(pathMod.resolve(upgradeLocation));
        const upgradeDir = parsedPath.dir;

        const toProcess = [[parsedPath.base]];

        while (toProcess.length > 0) {
            const upgradePath = toProcess.shift()!;

            const upgrade = pathMod.join(...upgradePath);

            const upgradeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "upgrade.sql");
            const downgradeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "downgrade.sql");
            const optionsTomlFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "migration.toml");

            if (optionsTomlFile === undefined) {
                // If we find a directory we add it to the stack for processing
                for (const file of await fs.readdir(pathMod.join(upgradeDir, ...upgradePath))) {
                    const fullPath = pathMod.join(upgradeDir, ...upgradePath, file);
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        toProcess.unshift([...upgradePath, file]);
                    }
                }

                continue;
            }

            if (upgradeFile === undefined) {
                console.warn(`Found invalid upgrade: ${upgrade}. Skipping`);
                continue;
            }

            const options = ZPiquedMigrationToml.parse(toml.parse(optionsTomlFile));

            upgradeInstances.push({
                version: options.version,
                name: upgrade,
                upgrade: upgradeFile,
                downgrade: downgradeFile,
                isolatedTx: options.isolatedTx ?? false,
                parents: options.parents ?? [],
            });
        }

        return new PiquedUpgradeControl(upgradeInstances);
    }

    public constructor(upgrades: PiquedUpgradeInstance[]) {
        this.#upgrades = upgrades;
    }

    public get upgradeGraph() {
        return PiquedUpgradeGraph.fromUpgrades(this.#upgrades);
    }

    private async performOperation(client: SmartClient, operation: Operation) {
        if (operation.upgrades.length === 0 && operation.downgrades.length === 0) {
            console.log("Nothing to do!");
            return;
        }

        for (const sequence of operation.upgrades) {
            await client.tx(async (client) => {
                const baseVersion = await this.takeVersionLock(client);
                for (const upgrade of sequence) {
                    try {
                        console.log(`Performing upgrade: ${upgrade.name}`);
                        await client.query(upgrade.upgrade);
                    } catch (e) {
                        const base = this.#upgrades.find((x) => x.version === baseVersion);
                        console.error(
                            `Failed to upgrade to ${upgrade.name}. Rolling back to ${base?.name ?? baseVersion}.`,
                        );
                        throw e;
                    }
                }
            });
        }

        for (const sequence of operation.downgrades) {
            await client.tx(async (client) => {
                const baseVersion = await this.takeVersionLock(client);
                for (const downgrade of sequence) {
                    try {
                        console.log(`Performing downgrade: ${downgrade.name}`);
                        await client.query(downgrade.downgrade!);
                    } catch (e) {
                        const base = this.#upgrades.find((x) => x.version === baseVersion);
                        console.error(
                            `Failed to downgrade to ${downgrade.name}. Rolling back to ${base?.name ?? baseVersion}.`,
                        );
                        throw e;
                    }
                }
            });
        }

        await this.updateVersion(client, operation.target);
    }

    /**
     * Performs the sequence of upgrades and/or downgrades needed to get from the
     * current version to the desired version (or latest if none is specified)
     *
     * Will throw an error if the path isn't specified (i.e. missing downgrade)
     * Takes a table level-lock to ensure multiple instances don't conflict.
     */
    public async upgradeToVersion(client: SmartClient, targetVersion?: string): Promise<void> {
        const operation: Operation = await client.tx(async (client) => {
            await this.initializePiqued(client);
            const head = await this.takeVersionLock(client);

            const upgradeGraph = PiquedUpgradeGraph.fromUpgrades(this.#upgrades);
            const graphHeads = upgradeGraph.heads;

            if (graphHeads.length === 0) {
                console.log("Found no heads in upgrade graph. Do you have a cycle?");
            }

            if (graphHeads.length > 1) {
                console.log("Found multiple heads in upgrade graph. Cannot proceed.");
                return { upgrades: [], downgrades: [], target: null };
            }

            const [graphHead] = graphHeads;

            if (head) {
                console.log(`Attempting migration from ${head} to ${targetVersion ?? graphHead}`);
                return upgradeGraph.getUpgradePlan(head, targetVersion ?? graphHead);
            } else {
                console.log("No version found. Initializing to target version.");
                return upgradeGraph.getInitializationPlan(targetVersion ?? graphHead);
            }
        });

        await this.performOperation(client, operation);
    }

    private async initializePiqued(client: SmartClient): Promise<void> {
        const tables = await client.q`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_name in ('_piqued_version', '_piqued_head');
        `;

        const knownTables = tables.rows.map((x) => x.table_name);
        if (knownTables.includes("_piqued_head")) {
            return;
        }

        let initialVersion: string | null = null;
        if (knownTables.includes("_piqued_version")) {
            const version = await client.q1<{ version: number }>`
                SELECT version
                FROM _piqued_version
                WHERE index_key = 1;
            `;

            initialVersion = `legacy_${version.version.toString()}`;
        }

        await client.q`
            CREATE TABLE IF NOT EXISTS _piqued_head (
                index_key int PRIMARY KEY,
                head text
            );
        `;

        await client.q`
            INSERT INTO _piqued_head (index_key, head)
            VALUES (1, ${initialVersion})
            ON CONFLICT (index_key) DO NOTHING;
        `;
    }

    private async takeVersionLock(client: SmartClient): Promise<string | null> {
        const { head } = await client.q1<{ head: string | null }>`
                SELECT head
                FROM _piqued_head
                WHERE index_key = 1
                FOR UPDATE;
            `;

        return head;
    }

    private async updateVersion(client: SmartClient, head: string | null): Promise<void> {
        await client.q`
            UPDATE _piqued_head
            SET head=${head}
            WHERE index_key=1
        `;
    }
}
