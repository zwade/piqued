import { Pool } from "pg";
import simpleQueries from "./simple-queries";
import { acquireColumnOrderCache, buildColumnOrderCache, Op, Select, SmartClient, tuple } from "@piqued/client";
import * as ns from "../types";
import { FtStateTable, PersonTable, Test2Table, UserAuthTable } from "../orm";

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

    using client = new SmartClient(await pool.connect(), { columnOrderCache, queryLogger: (query) => console.log(query) });

    // const result = await SimpleQueries.test({ force: false }, { uids: tuple(["866d3f55-a306-424e-a184-dbeec936dd1f"]) }).many();
    // console.log(result);
    // const result = await SimpleQueries.getPractices({}).one();
    // console.log(result.array_agg);
    // console.log(await SimpleQueries.selectArray({ $0: [1, 2, 3] }).many())

    const resultRaw = await pool.query("SELECT * FROM test_2");
    console.log(">>>", resultRaw.rows);

    const result =
        await Select(Test2Table.table)
        .from(Test2Table)
        .enableExperimentalMangle()
        .one(client);

    console.log(result.test_2.array_agg);

    await pool.end();
}

main()