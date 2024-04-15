import { Pool } from "pg";
import { SmartClient, getCurrentClient } from "./smart-client";
import { parseArray, parseObject } from "./parser";

export type CustomParseSpec =
    | { kind: "composite", fields: () => readonly (readonly [name: string, spec: ParseSpec])[] }
    | { kind: "enum", values: readonly string[] };
    ;

export type ParseSpec =
    | NumberConstructor | BooleanConstructor | StringConstructor | DateConstructor
    | CustomParseSpec
    ;

export type ResultSpec<OO> = [name: keyof OO, spec: ParseSpec | undefined][]

export type Query<IA extends any[], IO, OA, OO> = {
    name: string;
    query: string;
    params: (keyof IO)[];
    spec: ResultSpec<OO>;

    _brand: {
        inputArray: IA;
        inputobject: IO;
        outputArray: OA;
        outputObject: OO;
    };
};


export type Partialify<T extends boolean, Val> = T extends true ? Partial<Val> : Val;

export type Cursor<OA, OO> = {
    optTuple: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OA> | undefined>;
    oneTuple: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OA>>;
    manyTuples: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OA>[]>;
    opt: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OO> | undefined>;
    one: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OO>>;
    many: <Partial extends boolean = false>(client?: SmartClient) =>
        Promise<Partialify<Partial, OO>[]>;
}

export const QueryExecutor = <IA extends any[], IO, OA, OO>(
    query: Query<IA, IO, OA, OO>,
    pool: Pool
): QueryExecutor<IA, IO, OA, OO> => (args) => {
    const argsAsArray: unknown[] =
        Array.isArray(args) ? args :
        query.params.map((param) => args[param]);

    const q = <T>(fn: (client: SmartClient) => Promise<T>) =>
        async <IS_PARTIAL extends boolean = false>(
            client?: SmartClient
        ): Promise<IS_PARTIAL extends true ? Partial<T> : T> => {
            const foundClient = client ?? getCurrentClient();
            if (foundClient) {
                return await fn(foundClient);
            }

            const freshClient = await pool.connect();
            using smartClient = new SmartClient(freshClient);

            return await fn(smartClient);
        };

    const result: Cursor<OA, OO> =  {
        optTuple: q(async (client) => {
            const result = await client.queryArray(query.query, argsAsArray);
            if (result.rows.length === 0) {
                return undefined;
            }

            return parseArray<OO, OA>(query.spec, result.rows[0]);
        }),

        oneTuple: q(async (client) => {
            const result = await client.queryArray(query.query, argsAsArray);
            if (result.rows.length === 0) {
                throw new Error("No results");
            }

            return parseArray<OO, OA>(query.spec, result.rows[0]);
        }),

        manyTuples: q(async (client) => {
            const result = await client.queryArray(query.query,  argsAsArray );
            return result.rows.map((row) => parseArray<OO, OA>(query.spec, row));
        }),

        opt: q(async (client) => {
            const result = await client.query(query.query, argsAsArray);
            if (result.rows.length === 0) {
                return undefined;
            }

            return parseObject<OO>(query.spec, result.rows[0]);
        }),

        one: q(async (client) => {
            const result = await client.query(query.query, argsAsArray);
            if (result.rows.length === 0) {
                throw new Error("No results");
            }

            return parseObject<OO>(query.spec, result.rows[0]);
        }),

        many: q(async (client) => {
            const result = await client.query(query.query, argsAsArray);
            return result.rows.map((row) => parseObject<OO>(query.spec, row));
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