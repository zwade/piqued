import type { Pool, PoolClient } from "pg";

export type Query<IA extends any[], IO, OA, OO> = {
    name: string;
    query: string;
    params: (keyof IO)[];

    _brand: {
        inputArray: IA;
        inputobject: IO;
        outputArray: OA;
        outputObject: OO;
    };
};


export type Cursor<OA, OO> = {
    oneTuple: () => Promise<OA>;
    manyTuples: () => Promise<OA[]>;
    one: () => Promise<OO>;
    many: () => Promise<OO[]>;
}

const makeQuery = (pool: Pool) => <T>(cb: (client: PoolClient) => Promise<T>) => async (): Promise<T> => {
    const db = await pool.connect();

    try {
        return await cb(db);
    } catch (e) {
        throw e;
    } finally {
        db.release();
    };
}

export const QueryExecutor = <IA extends any[], IO, OA, OO>(
    query: Query<IA, IO, OA, OO>,
    pool: Pool
): QueryExecutor<IA, IO, OA, OO> => (args) => {
    const argsAsArray =
        Array.isArray(args) ? args :
        query.params.map((param) => args[param]);

    const q = makeQuery(pool);

    const result: Cursor<OA, OO> =  {
        oneTuple: q(async (client) => {
            const result = await client.query({ text: query.query, rowMode: "array", values: argsAsArray });
            if (result.rows.length === 0) {
                throw new Error("No results");
            }

            return result.rows[0] as OA;
        }),

        manyTuples: q(async (client) => {
            const result = await client.query({ text: query.query, rowMode: "array", values: argsAsArray });
            return result.rows as OA[];
        }),

        one: q(async (client) => {
            const result = await client.query({ text: query.query, values: argsAsArray });
            if (result.rows.length === 0) {
                throw new Error("No results");
            }

            return result.rows[0];
        }),

        many: q(async (client) => {
            const result = await client.query({ text: query.query, values: argsAsArray });
            return result.rows;
        }),
    };

    return result;
}

export interface QueryExecutor<IA extends any[], IO, OA, OO> {
    (args: IA): Cursor<OA, OO>;
    (args: IO): Cursor<OA, OO>;
}

export type QueryExecutors<T extends Record<string, Query<any[], any, any, any>>>= {
    [K in keyof T]: T[K] extends Query<infer IA, infer IO, infer OA, infer OO> ? QueryExecutor<IA, IO, OA, OO> : never;
};

export const EntityQueries = <T extends Record<string, Query<any[], any, any, any>>>(entities: T) => (pool: Pool) => {
    const result = {} as QueryExecutors<T>;
    for (const entity in entities) {
        result[entity] = QueryExecutor(entities[entity], pool) as any;
    }

    return result;
}