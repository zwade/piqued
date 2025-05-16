import type pg from "pg";

import { CustomParseSpec, ParseSpec } from "./types";

const columnOrderCacheSymbol = Symbol.for("columnOrderCache");

export type SingleNamespace = {
    name: string;
    spec: CustomParseSpec;
};

export type ColumnOrderCache = WeakMap<ParseSpec, CustomParseSpec>;

interface PoolWithCache extends pg.Pool {
    [columnOrderCacheSymbol]: ColumnOrderCache;
}

export const buildColumnOrderCache = async (
    ns: Record<string, SingleNamespace>,
    pool: pg.Pool,
    namespace: string = "public",
): Promise<void> => {
    // ~Same query as in piqued/src/query.rs
    const wellKnownTypes = await pool.query(
        `
        SELECT
            pg_type.typname as type_name,
            pg_attribute.attname as col_name,
            pg_attribute.attnum as col_order_num
        FROM pg_type
        INNER JOIN pg_namespace
            ON pg_type.typnamespace = pg_namespace.oid
        INNER JOIN pg_attribute
            ON pg_type.typrelid = pg_attribute.attrelid
        INNER JOIN pg_type col_type
            ON pg_attribute.atttypid = col_type.oid
        WHERE pg_namespace.nspname in ($1)
            AND pg_type.typcategory = 'C'
            AND pg_attribute.attnum > 0
            AND pg_type.typname NOT LIKE '%_seq' -- CR zwade for zwade: is there a better way to do this?
        ORDER BY
            pg_type.oid ASC,
            pg_attribute.attnum ASC
    `,
        [namespace],
    );

    const tablesByName = new Map<string, SingleNamespace>(Object.values(ns).map((spec) => [spec.name, spec]));
    const columnOrderData: Map<string, string[]> = wellKnownTypes.rows.reduce((acc, row) => {
        const columnOrder = acc.get(row.type_name) ?? [];
        columnOrder.push(row.col_name);

        acc.set(row.type_name, columnOrder);
        return acc;
    }, new Map<string, string[]>());

    const columnOrderCache = new Map<CustomParseSpec, CustomParseSpec>();
    for (const [tableName, trueColumns] of columnOrderData.entries()) {
        const table = tablesByName.get(tableName);
        if (table === undefined) {
            continue;
        }

        if (table.spec.kind === "composite") {
            const fields = table.spec.fields();

            // If we find a mismatch between the pre-computed order and the db order
            // then we create a new spec with the correct order
            // and add it to our columnOrderCache, for `parse` to later use.
            if (fields.some(([fieldName], i) => fieldName !== trueColumns[i])) {
                console.warn("Found mismatched column order for table", tableName);
                console.warn(
                    "Expected",
                    fields.map(([fieldName]) => fieldName),
                );
                console.warn("Found", trueColumns);

                const newSpec: [string, ParseSpec][] = [];
                for (const column of trueColumns) {
                    const field = fields.find(([fieldName]) => fieldName === column);
                    if (field === undefined) {
                        console.warn("Missing column", column);
                        newSpec.push([column, String]);
                        continue;
                    }

                    newSpec.push([column, field[1]]);
                }

                columnOrderCache.set(table.spec, { kind: "composite", fields: () => newSpec });
            }
        }
    }

    (pool as PoolWithCache)[columnOrderCacheSymbol] = columnOrderCache;
};

export const acquireColumnOrderCache = (pool: pg.Pool): ColumnOrderCache => {
    const columnOrderCache = (pool as PoolWithCache)[columnOrderCacheSymbol];
    if (columnOrderCache === undefined) {
        return new WeakMap<CustomParseSpec, CustomParseSpec>();
    }

    return columnOrderCache;
};
