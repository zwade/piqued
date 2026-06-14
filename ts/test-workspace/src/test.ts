import { acquireColumnOrderCache, alias, buildColumnOrderCache, Op, Select, SmartClient } from "@piqued/client";
import { Liveview, LiveviewEntry } from "@piqued/liveview";
import { Pool } from "pg";

import simpleQueries from "./data/simple-queries.js";
import { PersonTable, SessionTable } from "./orm.js";
import * as ns from "./types.js";

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "piqued_test",
    password: "password",
});

await buildColumnOrderCache(ns, pool);

const SimpleQueries = simpleQueries(pool);

const getClient = async () => {
    const client = await pool.connect();
    return new SmartClient(client, {
        columnOrderCache: acquireColumnOrderCache(pool),
        // queryLogger: (query) => console.log(query),
    });
};

const nameEntry: LiveviewEntry = {
    id: "name_reconcile",
    primaryTable: PersonTable,
    primaryKey: PersonTable.c.id,
    primaryKeyType: "int",
    triggers: [
        {
            kind: "column",
            column: PersonTable.c.first_name,
            when: Op.isNotNull(PersonTable.c.first_name),
        },
        {
            kind: "column",
            column: PersonTable.c.last_name,
            when: Op.isNotNull(PersonTable.c.last_name),
        },
        {
            kind: "time",
            column: PersonTable.c.created_at,
            to: "NOW",
        },
    ],
    actions: [
        {
            kind: "set",
            column: PersonTable.c.name,
            to: Op.concat(PersonTable.c.first_name, " ", PersonTable.c.last_name),
            async: false,
        },
        {
            kind: "fn",
            fn: async (client, dependencies) => {
                console.log("Updated person:", dependencies.person);
                if (Math.random() < 0.1) {
                    throw new Error("Random error for testing deadletter logic");
                }
            },
        },
    ],
};

const sessionEntry: LiveviewEntry = {
    id: "session_reconcile",
    primaryTable: PersonTable,
    primaryKey: PersonTable.c.id,
    primaryKeyType: "int",
    dependencies: [[SessionTable, PersonTable, Op.eq(SessionTable.c.user_id, PersonTable.c.id)]],
    triggers: [
        {
            kind: "column",
            column: SessionTable.c.last_active_at,
        },
    ],
    actions: [
        {
            kind: "set",
            column: PersonTable.c.last_active_at,
            to: SessionTable.c.last_active_at,
            async: true,
        },
    ],
};

const main = async () => {
    const liveview = new Liveview(getClient, [nameEntry, sessionEntry], {});

    await liveview.initialize();
    liveview.run();

    await new Promise((resolve) => setTimeout(resolve, 5_000));
};

main();
