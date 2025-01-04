import { Pool } from "pg";

import { parseArray, parseObject } from "./parser";
import { Expression, serializeExpression } from "./query-builder/expression-builder";
import { MutableSerializationState } from "./query-builder/serialize";
import { getCurrentClient, SmartClient } from "./smart-client";

export type CustomParseSpec =
    | { kind: "composite"; fields: () => readonly (readonly [name: string, spec: ParseSpec])[] }
    | { kind: "array"; spec: ParseSpec }
    | { kind: "enum"; values: readonly string[] };
export type ParseSpec =
    | NumberConstructor
    | BooleanConstructor
    | StringConstructor
    | DateConstructor
    | ObjectConstructor
    | BufferConstructor
    | CustomParseSpec;

export type ResultSpec<OO> = [name: keyof OO, spec: ParseSpec | undefined][];

export type Query<IA extends any[], IO, TIO, OA, OO> = {
    name: string;
    query: string;
    params: (keyof IO)[];
    templateParams: (keyof TIO)[];
    spec: ResultSpec<OO>;

    _brand: {
        inputArray: IA;
        inputObject: IO;
        templateInputObject: TIO;
        outputArray: OA;
        outputObject: OO;
    };
};

export type Partialify<T extends boolean, Val> = T extends true ? Partial<Val> : Val;

export type Cursor<OA, OO> = {
    optTuple: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OA> | undefined>;
    oneTuple: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OA>>;
    manyTuples: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OA>[]>;
    opt: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OO> | undefined>;
    one: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OO>>;
    many: <Partial extends boolean = false>(client?: SmartClient) => Promise<Partialify<Partial, OO>[]>;
};

export const QueryExecutor =
    <IA extends any[], IO, TIO, OA, OO>(
        query: Query<IA, IO, TIO, OA, OO>,
        pool: Pool,
    ): QueryExecutor<IA, IO, TIO, OA, OO> =>
    (args, templateArgs: TIO = {} as TIO) => {
        let argsAsArray: unknown[];
        let resolvedTemplateArgs: TIO;

        if (Array.isArray(args)) {
            argsAsArray = args;
            resolvedTemplateArgs = templateArgs;
        } else {
            argsAsArray = query.params.map((param) => args[param]);
            resolvedTemplateArgs = query.templateParams.reduce(
                (acc, tp) => ((acc[tp] ??= (args as IO & TIO)[tp]), acc),
                (templateArgs ?? {}) as TIO,
            );
        }

        const state: MutableSerializationState = { paramCount: 0, paramValues: [] };
        const formattedQuery = query.query.replace(/:__tmpl_([\w\d_]+)/g, (_, name) => {
            return serializeExpression(resolvedTemplateArgs[name as keyof TIO] as Expression, state, {
                inlineOnly: true,
            });
        });

        if (state.paramCount !== 0) {
            throw new Error("Inline expansion failed");
        }

        const q =
            <T>(fn: (client: SmartClient) => Promise<T>) =>
            async <IS_PARTIAL extends boolean = false>(
                client?: SmartClient,
            ): Promise<IS_PARTIAL extends true ? Partial<T> : T> => {
                const foundClient = client ?? getCurrentClient();
                if (foundClient) {
                    return await fn(foundClient);
                }

                const freshClient = await pool.connect();
                using smartClient = new SmartClient(freshClient);

                return await fn(smartClient);
            };

        const result: Cursor<OA, OO> = {
            optTuple: q(async (client) => {
                const result = await client.queryArray(formattedQuery, argsAsArray);
                if (result.rows.length === 0) {
                    return undefined;
                }

                return parseArray<OO, OA>(query.spec, result.rows[0]);
            }),

            oneTuple: q(async (client) => {
                const result = await client.queryArray(formattedQuery, argsAsArray);
                if (result.rows.length === 0) {
                    throw new Error("No results");
                }

                return parseArray<OO, OA>(query.spec, result.rows[0]);
            }),

            manyTuples: q(async (client) => {
                const result = await client.queryArray(formattedQuery, argsAsArray);
                return result.rows.map((row) => parseArray<OO, OA>(query.spec, row));
            }),

            opt: q(async (client) => {
                const result = await client.query(formattedQuery, argsAsArray);
                if (result.rows.length === 0) {
                    return undefined;
                }

                return parseObject<OO>(query.spec, result.rows[0]);
            }),

            one: q(async (client) => {
                const result = await client.query(formattedQuery, argsAsArray);
                if (result.rows.length === 0) {
                    throw new Error("No results");
                }

                return parseObject<OO>(query.spec, result.rows[0]);
            }),

            many: q(async (client) => {
                const result = await client.query(formattedQuery, argsAsArray);
                return result.rows.map((row) => parseObject<OO>(query.spec, row));
            }),
        };

        return result;
    };

export interface QueryExecutor<IA extends any[], IO, TIO, OA, OO> {
    (args: IA, templateArgs: TIO): Cursor<OA, OO>;
    (args: IO, templateArgs: TIO): Cursor<OA, OO>;
    (args: IO & TIO): Cursor<OA, OO>;
}

export type QueryExecutors<T extends Record<string, Query<any[], any, any, any, any>>> = {
    [K in keyof T]: T[K] extends Query<infer IA, infer IO, infer TIO, infer OA, infer OO>
        ? QueryExecutor<IA, IO, TIO, OA, OO>
        : never;
};

export const EntityQueries =
    <T extends Record<string, Query<any[], any, any, any, any>>>(entities: T) =>
    (pool: Pool) => {
        const result = {} as QueryExecutors<T>;
        for (const entity in entities) {
            result[entity] = QueryExecutor(entities[entity], pool) as any;
        }

        return result;
    };
