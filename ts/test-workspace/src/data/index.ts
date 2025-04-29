import { Pool } from "pg";
import simpleQueries from "./simple-queries";
import { tuple } from "@piqued/client";

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "postgres",
    password: "password",
})

const SimpleQueries = simpleQueries(pool);

const main = async () => {
    // const result = await SimpleQueries.test({ force: false }, { uids: tuple(["866d3f55-a306-424e-a184-dbeec936dd1f"]) }).many();
    // console.log(result);
    const stream = await SimpleQueries.several({}).stream(undefined);
    for await (const row of stream) {
        console.log(row);
    }

    await pool.end();
}

main()