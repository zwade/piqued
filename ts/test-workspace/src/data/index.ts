import { Pool } from "pg";
import simpleQueries from "./simple-queries";
import { buildColumnOrderCache, tuple } from "@piqued/client";
import * as ns from "../types";

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "postgres",
    password: "password",
})

const SimpleQueries = simpleQueries(pool);

const main = async () => {
    await buildColumnOrderCache(ns, pool);
    // const result = await SimpleQueries.test({ force: false }, { uids: tuple(["866d3f55-a306-424e-a184-dbeec936dd1f"]) }).many();
    // console.log(result);
    // const result = await SimpleQueries.getPractices({}).one();
    // console.log(result.array_agg);
    console.log(await SimpleQueries.selectArray({ $0: [1, 2, 3] }).many())

    await pool.end();
}

main()