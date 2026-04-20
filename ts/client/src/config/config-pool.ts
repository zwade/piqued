import { Pool } from "pg";

import { SmartClient } from "../smart-client.js";
import { PiquedConfig } from "./piqued-config.js";

/**
 * Generates a function that can be used to get a new smart client connected to the
 * database specified in the config. Note that this **will not** build the column order
 * cache so please do not try to use this with the ORM.
 */
export const getConfigPool = (config: PiquedConfig) => {
    const pool = new Pool({
        connectionString: config.postgres.uri,
    });

    return {
        checkout: async () => {
            const client = await pool.connect();
            return new SmartClient(client);
        },
        [Symbol.asyncDispose]: async () => {
            await pool.end();
        },
    };
};
