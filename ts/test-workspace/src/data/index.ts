import { Client, Connection, Pool } from "pg";
import simpleQueries from "./simple-queries";
import { acquireColumnOrderCache, buildColumnOrderCache, Op, Select, SmartClient, tuple } from "@piqued/client";
import * as ns from "../types";
import { FtStateTable, PersonTable, UserAuthTable } from "../orm";

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "postgres",
    password: "password",
})

const SimpleQueries = simpleQueries(pool);

const main = async () => {
    await buildColumnOrderCache(ns, pool);
    const columnOrderCache = await acquireColumnOrderCache(pool);
    const rawClient = await pool.connect()

    const promise = rawClient.query("SELECT pg_sleep(5)");
    console.log("Started query, cancelling it immediately...");

    await new Promise<void>((resolve) => {
        const con = new Connection({});
        con.connect(rawClient.port, rawClient.host)

        con.on('connect', function () {
            con.cancel(rawClient.processID, rawClient.secretKey)
            con.end();
            resolve();
        })
    })

    console.log("Cancelled query, waiting for it to resolve...");

    await promise.catch((err) => { console.log("Query error:", err.message); });
    console.log("Query cancelled");
    rawClient.release();
    return;


    using client = new SmartClient(await pool.connect(), { columnOrderCache, queryLogger: (query) => console.log(query) });

    // const result = await SimpleQueries.test({ force: false }, { uids: tuple(["866d3f55-a306-424e-a184-dbeec936dd1f"]) }).many();
    // console.log(result);
    // const result = await SimpleQueries.getPractices({}).one();
    // console.log(result.array_agg);
    // console.log(await SimpleQueries.selectArray({ $0: [1, 2, 3] }).many())

    const resultRaw = await pool.query("SELECT null::text");
    console.log(">>>", resultRaw.rows);

    const x: ns.Person.t = await Select(...PersonTable.star).from(PersonTable).one(client);
    x.email

    await pool.end();
}

main()