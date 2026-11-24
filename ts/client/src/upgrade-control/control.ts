import * as fs from "fs/promises";
import * as pathMod from "path";
import * as toml from "smol-toml";
import { z } from "zod";

import { SmartClient } from "../smart-client.js";
import { splitStatements } from "./split-statements.js";
import { Operation, PiquedUpgradeGraph, PiquedUpgradeInstance } from "./upgrade-graph.js";

export type PiquedMigrationToml = {
    version: string;
    parents?: string[];
    isolatedTx?: boolean;
    nonTransactional?: boolean;
};

export const ZPiquedMigrationToml = z.object({
    version: z.string(),
    parents: z.array(z.string()).optional(),
    isolatedTx: z.boolean().optional(),
    nonTransactional: z.boolean().optional(),
});

export interface UpgradeOptions {
    preventDowngrade?: boolean;
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
        } catch (_e) {
            return undefined;
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
                nonTransactional: options.nonTransactional ?? false,
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

    private async performOperation(
        client: SmartClient,
        operation: Operation,
        baseVersion: string | null,
        options: UpgradeOptions,
    ) {
        if (operation.upgrades.length === 0 && operation.downgrades.length === 0) {
            console.log("Nothing to do!");
            return true;
        }

        if (options.preventDowngrade) {
            const totalDowngrades = operation.downgrades.reduce((acc, x) => acc + x.length, 0);
            if (totalDowngrades > 0) {
                console.error(
                    "This operation would downgrade the database, but options.preventDowngrade is set to true.",
                );
                console.error("Cancelling this migration.");
                return false;
            }
        }

        const graph = this.upgradeGraph;
        let applied = baseVersion ? graph.ancestors(baseVersion) : new Set<string>();
        let head = baseVersion;

        const runSequence = async (sequence: PiquedUpgradeInstance[], direction: "upgrade" | "downgrade") => {
            const nextApplied = new Set(applied);
            for (const step of sequence) {
                if (direction === "upgrade") nextApplied.add(step.version);
                else nextApplied.delete(step.version);
            }

            // Only advance head when the applied set maps to a single node.
            const nextHead = graph.headOf(nextApplied);

            const apply = async (client: SmartClient) => {
                for (const step of sequence) {
                    const sql = direction === "upgrade" ? step.upgrade : step.downgrade!;
                    // Sent one at a time so Postgres doesn't wrap them in an implicit tx.
                    const statements = step.nonTransactional ? splitStatements(sql) : [sql];
                    let done = 0;
                    try {
                        console.log(`Performing ${direction}: ${step.name}`);
                        for (const statement of statements) {
                            await client.query(statement);
                            done++;
                        }
                    } catch (e) {
                        if (step.nonTransactional) {
                            console.error(
                                `Failed to ${direction} ${step.name} at statement ${done + 1} of ${statements.length}. ` +
                                    `It is non-transactional; the ${done} before it were applied.`,
                            );
                            console.error(statements[done]);
                        } else {
                            const base = this.#upgrades.find((x) => x.version === head);
                            console.error(
                                `Failed to ${direction} ${step.name}. Rolling back to ${base?.name ?? head}.`,
                            );
                        }
                        throw e;
                    }
                }

                if (nextHead !== undefined) {
                    await this.updateVersion(client, nextHead);
                }
            };

            if (sequence.length === 1 && sequence[0].nonTransactional) {
                await apply(client);
            } else {
                await client.tx(apply);
            }

            applied = nextApplied;
            if (nextHead !== undefined) head = nextHead;
        };

        for (const sequence of operation.upgrades) {
            await runSequence(sequence, "upgrade");
        }

        for (const sequence of operation.downgrades) {
            await runSequence(sequence, "downgrade");
        }

        if (head !== operation.target) {
            await this.updateVersion(client, operation.target);
        }

        return true;
    }

    /**
     * Performs the sequence of upgrades and/or downgrades needed to get from the
     * current version to the desired version (or latest if none is specified)
     *
     * Will throw an error if the path isn't specified (i.e. missing downgrade)
     * Takes a session-level advisory lock to ensure multiple instances don't conflict.
     *
     * Returns true if the operation was successful, false if it was cancelled.
     */
    public async upgradeToVersion(
        client: SmartClient,
        targetVersion: string | undefined = undefined,
        options: UpgradeOptions = {},
    ): Promise<boolean> {
        // Session-level so it spans the per-sequence txs and non-transactional steps.
        await client.q`SELECT pg_advisory_lock(hashtext('_piqued_head'))`;
        try {
            const { operation, head } = await client.tx(async (client) => {
                await this.initializePiqued(client);
                const head = await this.takeVersionLock(client);

                const upgradeGraph = PiquedUpgradeGraph.fromUpgrades(this.#upgrades);
                const graphHeads = upgradeGraph.heads;

                if (graphHeads.length === 0) {
                    console.log("Found no heads in upgrade graph. Do you have a cycle?");
                }

                if (graphHeads.length > 1) {
                    console.log("Found multiple heads in upgrade graph. Cannot proceed.");
                    return { head, operation: { upgrades: [], downgrades: [], target: null } as Operation };
                }

                const [graphHead] = graphHeads;

                if (head) {
                    console.log(`Attempting migration from ${head} to ${targetVersion ?? graphHead}`);
                    return { head, operation: upgradeGraph.getUpgradePlan(head, targetVersion ?? graphHead) };
                } else {
                    console.log("No version found. Initializing to target version.");
                    return { head, operation: upgradeGraph.getInitializationPlan(targetVersion ?? graphHead) };
                }
            });

            return await this.performOperation(client, operation, head, options);
        } finally {
            await client.q`SELECT pg_advisory_unlock(hashtext('_piqued_head'))`;
        }
    }

    private async initializePiqued(client: SmartClient): Promise<void> {
        await client.q`
            CREATE TABLE IF NOT EXISTS _piqued_head (
                index_key int PRIMARY KEY,
                head text
            );
        `;

        await client.q`
            INSERT INTO _piqued_head (index_key, head)
            VALUES (1, NULL)
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
