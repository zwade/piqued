import { serializeExpressionAsString, SmartClient, tuple } from "@piqued/client";
import { createHash } from "node:crypto";

import { compileDependencyQuery } from "./dependency-compiler.js";
import { LiveviewAsset, LiveviewAssetType, LiveviewEntry } from "./liveview.js";
import { HarnessV1, initializeHarnessV1 } from "./liveview-harness-v1.js";
import { compileTriggers } from "./trigger-compiler.js";

type ToDelete = {
    function: HarnessV1.RegisteredAsset[];
    trigger: HarnessV1.RegisteredAsset[];
    time_trigger: HarnessV1.RegisteredAsset[];
};
type ToCreate = { function: LiveviewAsset[]; trigger: LiveviewAsset[]; time_trigger: LiveviewAsset[] };

const dbTypeToTsType = (type: HarnessV1.AssetType): LiveviewAssetType =>
    type === "FUNCTION" ? "function" : type === "TRIGGER" ? "trigger" : "time_trigger";

const tsTypeToDbType = (type: LiveviewAssetType): HarnessV1.AssetType =>
    type === "function" ? "FUNCTION" : type === "trigger" ? "TRIGGER" : "TEMPORAL";

const getHash = (sql: string) => createHash("sha256").update(sql).digest("base64");

export type ExecutionStatus =
    | { kind: "pending" }
    | { kind: "initialized" }
    | { kind: "idle"; nextRun: NodeJS.Timeout }
    | { kind: "running"; done: Promise<void> };

export interface LiveviewOptions {
    pollingIntervalMs?: number;
    logger?: (message: string, ...args: any[]) => void;
}

export class Liveview {
    private getClient;
    private knownEntries;
    private options;

    #status: ExecutionStatus = { kind: "pending" };

    constructor(
        getClient: () => SmartClient | Promise<SmartClient>,
        defaultEntries: LiveviewEntry[] = [],
        options: LiveviewOptions = {},
    ) {
        this.getClient = getClient;
        this.knownEntries = Array.from(defaultEntries);
        this.options = options;
    }

    private log(message: string, ...args: any[]) {
        if (this.options.logger) {
            this.options.logger(message, ...args);
        }
    }

    private async deleteAsset(client: SmartClient, asset: HarnessV1.RegisteredAsset) {
        this.log(`Deleting asset "${asset.asset_name}"`);

        switch (asset.asset_type) {
            case "FUNCTION": {
                await client.query(`DROP FUNCTION IF EXISTS "${asset.asset_name}";`);
                break;
            }

            case "TRIGGER": {
                await client.query(`DROP TRIGGER IF EXISTS "${asset.asset_name}" ON "${asset.trigger_table}";`);
                break;
            }

            case "TEMPORAL": {
                await client.query(
                    `DELETE FROM "piqued_liveview"."time_trigger_state" WHERE name = ${serializeExpressionAsString(asset.asset_name)};`,
                );
            }
        }

        await client.q`DELETE FROM "piqued_liveview"."registered_asset" WHERE id=${asset.id}`;
    }

    private async createAsset(client: SmartClient, view: HarnessV1.RegisteredView, asset: LiveviewAsset) {
        const hash = getHash(asset.sql);

        this.log(`Creating asset "${asset.name}"`);

        await client.query(asset.sql);
        await client.q`INSERT INTO "piqued_liveview"."registered_asset" (view_id, asset_type, asset_name, asset_hash, trigger_table)
VALUES (${view.id}, ${tsTypeToDbType(asset.kind)}, ${asset.name}, ${hash}, ${asset.triggerTable ?? null});`;
    }

    private reconcileAssets(registered: HarnessV1.RegisteredAsset[], entry: LiveviewEntry) {
        const assetsByName = new Map(registered.map((value) => [value.asset_name, value] as const));
        const remainingAssets = new Set(assetsByName.keys());

        const currentAssets = compileTriggers(entry);

        const toDelete: ToDelete = { function: [], trigger: [], time_trigger: [] };
        const toCreate: ToCreate = { function: [], trigger: [], time_trigger: [] };

        for (const asset of currentAssets) {
            const existingAsset = assetsByName.get(asset.name);
            if (!existingAsset) {
                toCreate[asset.kind].push(asset);
                continue;
            }

            remainingAssets.delete(asset.name);

            const hash = getHash(asset.sql);
            if (hash !== existingAsset.asset_hash) {
                toDelete[asset.kind].push(existingAsset);
                toCreate[asset.kind].push(asset);
            }
        }

        for (const remaining of remainingAssets) {
            const asset = assetsByName.get(remaining)!;
            toDelete[dbTypeToTsType(asset.asset_type)].push(asset);
        }

        return { toDelete, toCreate };
    }

    private async reconcileEntry(client: SmartClient, entry: LiveviewEntry) {
        let registeredEntry = await client.q1Opt<HarnessV1.RegisteredView>`
            SELECT * FROM "piqued_liveview"."registered_view"
            WHERE name = ${entry.id};
        `;

        if (!registeredEntry) {
            this.log(`Registering new liveview entry [${entry.id}]`);

            registeredEntry = await client.q1<HarnessV1.RegisteredView>`
                INSERT INTO "piqued_liveview"."registered_view" (name)
                VALUES (${entry.id})
                RETURNING *;
            `;
        }

        const existingAssets = await client.q<HarnessV1.RegisteredAsset>`
            SELECT *
            FROM "piqued_liveview"."registered_asset"
            WHERE view_id = ${registeredEntry.id};
        `;

        const { toCreate, toDelete } = this.reconcileAssets(existingAssets.rows, entry);
        const forwardOrder = ["function", "trigger", "time_trigger"] as const;
        const reverseOrder = forwardOrder.slice().reverse();

        for (const assetType of reverseOrder) {
            for (const asset of toDelete[assetType]) {
                await this.deleteAsset(client, asset);
            }
        }

        for (const assetType of forwardOrder) {
            for (const asset of toCreate[assetType]) {
                await this.createAsset(client, registeredEntry, asset);
            }
        }
    }

    private async teardownEntry(client: SmartClient, entry: HarnessV1.RegisteredView) {
        this.log(`Tearing down liveview entry [${entry.name}]`);

        const allAssets = await client.q<HarnessV1.RegisteredAsset>`
            SELECT * FROM "piqued_liveview"."registered_asset"
            WHERE view_id = ${entry.id};
        `;

        const triggers = allAssets.rows.filter((value) => value.asset_type === "TRIGGER");
        const functions = allAssets.rows.filter((value) => value.asset_type === "FUNCTION");
        const timeTriggers = allAssets.rows.filter((value) => value.asset_type === "TEMPORAL");

        for (const asset of timeTriggers) {
            await this.deleteAsset(client, asset);
        }

        for (const asset of triggers) {
            await this.deleteAsset(client, asset);
        }

        for (const asset of functions) {
            await this.deleteAsset(client, asset);
        }

        await client.q`
            DELETE FROM "piqued_liveview"."registered_view"
            WHERE id=${entry.id};
        `;
    }

    private async initializeEntries(client: SmartClient) {
        await client.tx(async (client) => {
            const existingEntries = await client.q<HarnessV1.RegisteredView>`
                SELECT * FROM "piqued_liveview"."registered_view";
            `;

            const knownEntryNames = new Set(this.knownEntries.map((v) => v.id));
            const unneededEntries = existingEntries.rows.filter((entry) => !knownEntryNames.has(entry.name));

            for (const entry of unneededEntries) {
                await this.teardownEntry(client, entry);
            }

            for (const entry of this.knownEntries) {
                await this.reconcileEntry(client, entry);
            }
        });
    }

    private async checkAndPerformCallbacks(client: SmartClient) {
        return await client.tx(async (client) => {
            const queueEntries = await client.q<HarnessV1.HostFnQueue>`
                SELECT * FROM "piqued_liveview"."host_fn_queue"
                ORDER BY created_at ASC
                LIMIT 50
                FOR UPDATE SKIP LOCKED;
            `;

            if (queueEntries.rows.length === 0) {
                return true;
            }

            const deadletteredEntries: { row: HarnessV1.HostFnQueue; error_message: string }[] = [];

            for (const row of queueEntries.rows) {
                const { id, entry_id, primary_key, async_callback_name } = row;
                if (async_callback_name) {
                    this.log(`Executing async callback for entry [${entry_id}] with primary key "${primary_key}"`);

                    try {
                        await client.tx(async (client) => {
                            await client.query(`SELECT "piqued_liveview"."${async_callback_name}"($1)`, [primary_key]);
                        });
                    } catch (err) {
                        console.error(`Error executing async callback for entry ${entry_id}:`, err);
                        deadletteredEntries.push({ row, error_message: String(err) });

                        continue;
                    }
                }

                const entry = this.knownEntries.find((e) => e.id === entry_id);
                if (!entry) {
                    console.warn(`No entry found for id ${entry_id}, skipping callback`);
                    continue;
                }

                const callbackActions = entry?.actions.filter((action) => action.kind === "fn") ?? [];

                if (callbackActions.length > 0) {
                    this.log(
                        `Executing ${callbackActions.length} user-defined callback(s) for entry [${entry_id}] with primary key "${primary_key}"`,
                    );

                    const dependencies = await compileDependencyQuery(client, entry!, primary_key);

                    for (const action of callbackActions) {
                        try {
                            await client.tx(async (client) => {
                                await action.fn(client, dependencies);
                            });
                        } catch (err) {
                            console.error(`Error executing callback for entry [${entry_id}]:`, err);
                            deadletteredEntries.push({ row, error_message: String(err) });

                            continue;
                        }
                    }
                }
            }

            for (const { row, error_message } of deadletteredEntries) {
                await client.q`
                    INSERT INTO "piqued_liveview"."host_fn_queue_deadletter" (entry_id, primary_key, async_callback_name, error_message)
                    VALUES (${row.entry_id}, ${row.primary_key}, ${row.async_callback_name ?? null}, ${error_message});
                `;
            }

            const idsToDelete = queueEntries.rows.map((row) => row.id);
            await client.query(`
                DELETE FROM "piqued_liveview"."host_fn_queue"
                WHERE id IN ${serializeExpressionAsString(tuple(idsToDelete))};
            `);

            return queueEntries.rows.length !== 50;
        });
    }

    private async checkAndPerformTimeTriggers(client: SmartClient) {
        return await client.tx(async (client) => {
            const timeTriggers = await client.q<HarnessV1.TimeTriggerState>`
                SELECT *
                FROM "piqued_liveview"."time_trigger_state"
                WHERE (end_time IS NULL OR end_time > last_triggered_time)
                FOR UPDATE SKIP LOCKED;
        `;

            let done = true;
            for (const trigger of timeTriggers.rows) {
                try {
                    await client.tx(async (client) => {
                        const result = await client.query(
                            `
                            WITH
                            trigger_state AS (
                                SELECT *
                                FROM "piqued_liveview"."time_trigger_state"
                                WHERE name = $1
                                FOR UPDATE
                            ),
                            updates AS (
                                SELECT
                                    "${trigger.table_name}"."${trigger.column_name}" as time,
                                    "${trigger.table_name}"."${trigger.primary_key_name}"::text as primary_key,
                                    "piqued_liveview"."${trigger.callback_name}"("${trigger.table_name}") as _res
                                FROM "${trigger.table_name}"
                                CROSS JOIN trigger_state
                                WHERE
                                    ("${trigger.table_name}"."${trigger.column_name}", "${trigger.table_name}"."${trigger.primary_key_name}"::text) > (trigger_state.last_triggered_time, trigger_state.last_triggered_key)
                                    AND (trigger_state.start_time IS NULL OR "${trigger.table_name}"."${trigger.column_name}" >= trigger_state.start_time)
                                    AND (trigger_state.end_time IS NULL OR "${trigger.table_name}"."${trigger.column_name}" <= trigger_state.end_time)
                                ORDER BY
                                    "${trigger.table_name}"."${trigger.column_name}" ASC,
                                    "${trigger.table_name}"."${trigger.primary_key_name}"::text ASC
                                LIMIT 50
                            ),
                            stats_count AS (
                                SELECT count(*) as count
                                FROM updates
                            ),
                            stats_max AS (
                                SELECT time as max_time, primary_key as max_key
                                FROM updates
                                ORDER BY time DESC, primary_key DESC
                                LIMIT 1
                            )
                            UPDATE "piqued_liveview"."time_trigger_state"
                            SET last_triggered_time = coalesce((SELECT max_time FROM stats_max), last_triggered_time),
                                last_triggered_key = coalesce((SELECT max_key FROM stats_max), last_triggered_key)
                            WHERE name = $1
                            RETURNING
                                (SELECT count FROM stats_count) as count,
                                (SELECT max_time FROM stats_max) as max_time,
                                (SELECT max_key FROM stats_max) as max_key
                                ;
                            `,
                            [trigger.name],
                        );

                        const count = +(result.rows[0]?.count ?? 0);

                        if (count === 0) {
                            return;
                        }

                        this.log(
                            `Performing ${count} time trigger(s) "${trigger.name}" for entry [${trigger.entry_id}]`,
                        );

                        if (count === 50) {
                            done = false;
                        }
                    });
                } catch (err) {
                    console.error(
                        `Error executing time trigger "${trigger.name}" for entry [${trigger.entry_id}]:`,
                        err,
                    );

                    // Effectively discards any updates, but prevents crash loops
                    // TODO: Deadletter the lost updates
                    await client.q`
                        UPDATE "piqued_liveview"."time_trigger_state"
                        SET last_triggered_time = ${new Date()},
                            last_triggered_key = ''
                        WHERE name = ${trigger.name};
                    `;
                }
            }

            return done;
        });
    }

    private async eventLoop() {
        if (this.#status.kind !== "idle") {
            return;
        }

        let doneCb: () => void;
        const donePromise = new Promise<void>((resolve) => (doneCb = resolve));

        this.#status = { kind: "running", done: donePromise };

        try {
            using client = await this.getClient();

            while (true) {
                const callbacks = [
                    await this.checkAndPerformCallbacks(client),
                    await this.checkAndPerformTimeTriggers(client),
                ];

                const done = callbacks.every((v) => v);
                if (done) {
                    break;
                }
            }
        } finally {
            const timeout = this.options.pollingIntervalMs ?? 1_000;
            this.#status = { kind: "idle", nextRun: setTimeout(() => this.eventLoop(), timeout) };
            doneCb!();
        }
    }

    public get status() {
        return this.#status.kind;
    }

    public async initialize() {
        if (this.#status.kind !== "pending") {
            throw new Error(`Can't initialize liveview, already in status ${this.status}`);
        }

        using client = await this.getClient();

        this.log("Initializing liveview runtime");

        await initializeHarnessV1(client);
        await this.initializeEntries(client);

        this.#status = { kind: "initialized" };
    }

    public run() {
        if (this.#status.kind !== "initialized") {
            throw new Error(`Can't run liveview, currently in status ${this.status}`);
        }

        this.log("Starting liveview event loop");
        this.#status = { kind: "idle", nextRun: setTimeout(() => this.eventLoop(), 0) };
    }

    public async stop() {
        while (this.#status.kind === "running") {
            await this.#status.done;
        }

        if (this.#status.kind === "idle") {
            clearTimeout(this.#status.nextRun);
        }

        this.log("Liveview stopped");
        this.#status = { kind: "initialized" };
    }

    public async [Symbol.asyncDispose]() {
        await this.stop();
    }
}
