import * as fs from "fs/promises";
import * as pathMod from "path";

import { SmartClient } from "./smart-client.js";

export class PiquedUpgradeInstance {
    constructor(
        public version: number,
        public upgrade: string,
        public downgrade?: string,
        public initialize?: string,
    ) {}
}

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

    public static async fromDir(upgradeDir: string) {
        const ugprades = await fs.readdir(upgradeDir);
        const upgradeInstances: PiquedUpgradeInstance[] = [];

        for (const upgrade of ugprades) {
            const asNum = parseInt(upgrade, 10);
            if (Number.isNaN(asNum)) {
                if (!upgrade.startsWith(".")) {
                    console.warn(`Found invalid upgrade: ${upgrade}. Skipping`);
                }

                continue;
            }

            const upgradeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "upgrade.sql");
            const downgradeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "downgrade.sql");
            const initializeFile = await PiquedUpgradeControl.tryRead(upgradeDir, upgrade, "initialize.sql");

            if (upgradeFile === undefined) {
                console.warn(`Found invalid upgrade: ${upgrade}. Skipping`);
                continue;
            }

            upgradeInstances.push(new PiquedUpgradeInstance(asNum, upgradeFile, downgradeFile, initializeFile));
        }

        // Intentionally sorting in place 🤮
        upgradeInstances.sort((a, b) => a.version - b.version);
        upgradeInstances.forEach((inst, i) => {
            if (inst.version !== i + 1) {
                throw new Error(`Unable to process upgrade directory. Missing upgrade #${i}`);
            }
        });

        return new PiquedUpgradeControl(upgradeInstances);
    }

    public constructor(upgrades: PiquedUpgradeInstance[]) {
        this.#upgrades = upgrades;
    }

    /**
     * Performs the sequence of upgrades and/or downgrades needed to get from the
     * current version to the desired version (or latest if none is specified)
     *
     * Will throw an error if the path isn't specified (i.e. missing downgrade)
     * Takes a table level-lock to ensure multiple instances don't conflict.
     */
    public async upgradeToVersion(client: SmartClient, targetVersion?: number): Promise<void> {
        await client.tx(async (client) => {
            await this.initializePiqued(client);
            const version = await this.takeVersionLock(client);

            const destinationVersion = targetVersion ?? this.#upgrades.length;

            if (destinationVersion === version) {
                console.log("Nothing to do!");
                return;
            }

            if (destinationVersion > version) {
                console.log(`Starting upgrade from ${version} to ${destinationVersion}`);

                for (let i = version + 1; i <= destinationVersion; i++) {
                    console.log(`Performing upgrade: ${i}`);

                    try {
                        await client.query(this.#upgrades[i - 1].upgrade);
                    } catch (e) {
                        console.error(`Failed to upgrade to version ${i}. Rolling back to ${version}.`);
                        throw e;
                    }
                }
            }

            if (destinationVersion < version) {
                const allowedToDowngrade = this.#upgrades
                    .slice(destinationVersion, version + 1)
                    .every((x) => x.downgrade !== undefined);

                if (!allowedToDowngrade) {
                    console.error(
                        `Downgrading from ${version} to ${destinationVersion} failed. Missing one or more downgrade scripts.`,
                    );

                    throw new Error("Couldn't downgrade");
                }

                console.log(`Downgrading from ${version} to ${destinationVersion}`);

                for (let i = version; i > destinationVersion; i--) {
                    console.log(`Performing downgrade: ${i}`);

                    try {
                        await client.query(this.#upgrades[i - 1].downgrade!);
                    } catch (e) {
                        console.error(`Failed to upgrade to version ${i}. Rolling back to ${version}.`);
                        throw e;
                    }
                }
            }

            await this.updateVersion(client, destinationVersion);
            console.log(`Completed upgrade. DB now at version: ${destinationVersion}`);
        });
    }

    public async initializeToVersion(client: SmartClient, targetVersion?: number): Promise<void> {
        await client.tx(async (client) => {
            await this.initializePiqued(client);
            const version = await this.takeVersionLock(client);

            if (version !== 0) {
                console.warn(`Database already initialized at version ${version}! Performing upgrade instead`);
                return await this.upgradeToVersion(client, targetVersion);
            }

            const destinationVersion = targetVersion ?? this.#upgrades.length;

            const lastAvailableInitializer = this.#upgrades.reduce(
                (foundVersion, upgrade) => {
                    if (upgrade.version > destinationVersion) {
                        return foundVersion;
                    }

                    if (upgrade.initialize !== undefined) {
                        return upgrade.version;
                    }

                    return foundVersion;
                },
                undefined as number | undefined,
            );

            if (lastAvailableInitializer !== undefined) {
                const initializer = this.#upgrades[lastAvailableInitializer - 1].initialize!;

                if (lastAvailableInitializer === destinationVersion) {
                    console.log(`Initializing database to version ${lastAvailableInitializer}`);
                    await client.query(initializer);
                    await this.updateVersion(client, destinationVersion);

                    return;
                }

                console.log(`Initializing to version ${lastAvailableInitializer} and upgrading from there.`);
                await client.query(initializer);
                await this.updateVersion(client, lastAvailableInitializer);
            }

            console.log(`Completing initialization by upgrading to version ${destinationVersion}`);
            await this.upgradeToVersion(client, destinationVersion);
        });
    }

    private async initializePiqued(client: SmartClient): Promise<void> {
        await client.q`
                CREATE TABLE IF NOT EXISTS _piqued_version (
                    index_key int PRIMARY KEY,
                    version int NOT NULL
                );
            `;

        await client.q`
                INSERT INTO _piqued_version (index_key, version)
                SELECT 1, coalesce(max(version), 0) as version
                    FROM _piqued_version
                    WHERE index_key = 1
                ON CONFLICT (index_key)
                    DO NOTHING;
            `;
    }

    private async takeVersionLock(client: SmartClient): Promise<number> {
        const { version } = await client.q1<{ version: number }>`
                SELECT version
                FROM _piqued_version
                WHERE index_key = 1
                FOR UPDATE;
            `;

        return version;
    }

    private async updateVersion(client: SmartClient, version: number): Promise<void> {
        await client.q`
            UPDATE _piqued_version
            SET version=${version}
            WHERE index_key=1
        `;
    }
}
