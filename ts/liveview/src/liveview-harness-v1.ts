import { SmartClient } from "@piqued/client";

export declare namespace HarnessV1 {
    export interface LiveviewVersion {
        version: number;
    }

    export interface HostFnQueue {
        id: number;
        entry_id: string;
        primary_key: string;
        async_callback_name?: string;
        created_at: Date;
    }

    export interface HostFnQueueDeadletter {
        id: number;
        entry_id: string;
        primary_key: string;
        async_callback_name?: string;
        created_at: Date;
        error_message: string;
    }

    export interface TimeTriggerState {
        name: string;
        entry_id: string;
        table_name: string;
        column_name: string;
        primary_key_name: string;
        callback_name: string;
        last_triggered_time: Date;
        last_triggered_key: string;
        start_time?: Date;
        end_time?: Date;
    }

    export interface RegisteredView {
        id: number;
        created_at: Date;
        name: string;
        enabled: boolean;
    }

    export type AssetType = "FUNCTION" | "TRIGGER" | "TEMPORAL";

    export interface RegisteredAsset {
        id: number;
        created_at: Date;
        view_id: number;
        asset_type: AssetType;
        asset_name: string;
        asset_hash: string;
        trigger_table?: string;
    }
}

export const initializeHarnessV1 = async (client: SmartClient) => {
    await client.tx(async (client) => {
        const exists = await client.q1Opt`
            SELECT table_name
            FROM information_schema.tables
            WHERE (table_schema, table_name) = ('piqued_liveview', 'liveview_version');
        `;

        if (exists) {
            const { version } = await client.q1<HarnessV1.LiveviewVersion>`
                SELECT version
                FROM "piqued_liveview"."liveview_version";
            `;

            if (version !== 1) {
                throw new Error(`Can't initialize v1 harness. Liveview is currently on version ${version}`);
            }

            return;
        }

        await client.q`
            CREATE SCHEMA IF NOT EXISTS "piqued_liveview";

            CREATE TABLE "piqued_liveview"."liveview_version" (
                version int NOT NULL
            );

            CREATE TABLE "piqued_liveview"."host_fn_queue" (
                id SERIAL PRIMARY KEY,
                entry_id TEXT NOT NULL,
                primary_key TEXT NOT NULL,
                async_callback_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE "piqued_liveview"."host_fn_queue_deadletter" (
                id SERIAL PRIMARY KEY,
                entry_id TEXT NOT NULL,
                primary_key TEXT NOT NULL,
                async_callback_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                error_message TEXT NOT NULL
            );

            CREATE TABLE "piqued_liveview"."time_trigger_state" (
                name TEXT PRIMARY KEY,
                entry_id TEXT NOT NULL,
                table_name TEXT NOT NULL,
                column_name TEXT NOT NULL,
                primary_key_name TEXT NOT NULL,
                callback_name TEXT NOT NULL,
                last_triggered_time TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
                last_triggered_key TEXT NOT NULL DEFAULT '',
                start_time TIMESTAMPTZ,
                end_time TIMESTAMPTZ
            );

            CREATE TABLE "piqued_liveview"."registered_view" (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                name TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT true
            );

            CREATE TYPE "piqued_liveview"."asset_type" AS ENUM (
                'TRIGGER',
                'FUNCTION',
                'TEMPORAL'
            );

            CREATE TABLE "piqued_liveview"."registered_asset" (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                view_id INTEGER NOT NULL REFERENCES "piqued_liveview"."registered_view" (id),
                asset_type "piqued_liveview"."asset_type" NOT NULL,
                asset_name TEXT NOT NULL,
                asset_hash TEXT NOT NULL,
                trigger_table TEXT
            );

            INSERT INTO "piqued_liveview"."liveview_version" (version) VALUES (1);
        `;
    });
};
