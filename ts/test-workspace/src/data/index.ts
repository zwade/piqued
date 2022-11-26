import { Pool } from "pg";
import simpleQueries from "./simple-queries";

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "postgres",
    password: "hola12",
})

const SimpleQueries = simpleQueries(pool);

const main = async () => {
    const resObj = await SimpleQueries.reflect(["Hello world"]).one();
    const resTup = await SimpleQueries.reflect2({ first: "Hello world", second: "again" }).oneTuple();

    console.log(resObj)
    console.log(resTup);

    await pool.end();
}

main()