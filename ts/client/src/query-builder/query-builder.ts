import { QueryResultRow } from "pg";

import { ColumnOrderCache } from "../order-managment.js";
import { parseTopLevel } from "../parser.js";
import { SmartClient, StreamOptions, StreamShape } from "../smart-client.js";
import { ParseSpec } from "../types.js";
import {
    ColumnExpression,
    Expression,
    FunctionOperation,
    Label,
    Op,
    serializeExpression,
    TableBuilder,
    TableExpression,
} from "./expression-builder.js";
import { MutableSerializationState, ScalarNameOf, ScalarValueOf, SerializeOptions, SubQuery } from "./serialize.js";

export type ResultState = {
    results: Record<string, unknown>;
};

export type ParserKind =
    | {
          kind: "single";
          spec: ParseSpec | null;
      }
    | { kind: "mangled"; spec: ParseSpec | null; parentObjectName: string; parentColumnName: string };

export abstract class ExecutableQuery<T extends ResultState> extends SubQuery<
    ScalarValueOf<T["results"]>,
    ScalarNameOf<T["results"]>
> {
    #parserMap: Record<string, ParserKind> | null = null;

    protected abstract selections: (Expression | Label)[];
    protected experimentalMangle: boolean = false;

    /**
     * Used with the new `experimentalMangle` feature to rewrite selection lists
     * (e.g. `SELECT ... FROM table`) to expand table selections into individual columns.
     */
    protected buildSelectionList(state: MutableSerializationState, options: SerializeOptions) {
        if (!this.experimentalMangle) {
            return this.selections.map((e) => serializeExpression(e, state, options)).join(", ");
        } else {
            const accumulator: string[] = [];
            for (const e of this.selections) {
                if (e instanceof TableExpression) {
                    for (const [colName, colParser] of e.parser.fields()) {
                        accumulator.push(
                            serializeExpression(
                                new Label(new ColumnExpression(e.name, colName, colParser), `_${e.name}__${colName}`),
                                state,
                                options,
                            ),
                        );
                    }
                } else {
                    // TODO: Special handling of labeled table expressions
                    accumulator.push(serializeExpression(e, state, options));
                }
            }

            return accumulator.join(", ");
        }
    }

    /**
     * Turns on experimental mangling of nested objects for the query
     */
    public enableExperimentalMangle<TS extends ExecutableQuery<any>>(this: TS): TS {
        this.experimentalMangle = true;

        return this;
    }

    public serialize(): { data: string; values: any[] } {
        const state: MutableSerializationState = {
            paramCount: 0,
            paramValues: [],
        };

        return {
            data: this.serializeInto(state, {}) + ";",
            values: state.paramValues,
        };
    }

    public async execute(client: SmartClient): Promise<void> {
        const { data, values } = this.serialize();
        await client.query(data, values);
    }

    public async one(client: SmartClient): Promise<T["results"]> {
        const { data, values } = this.serialize();
        const result = await client.query(data, values);

        const row = result.rows[0];
        if (!row) {
            throw new Error("No results");
        }

        return this.postProcessRow(row, client.columnOrderCache);
    }

    public async opt(client: SmartClient): Promise<T["results"] | undefined> {
        const { data, values } = this.serialize();
        const result = await client.query(data, values);

        const row = result.rows[0];
        if (!row) {
            return undefined;
        }

        return this.postProcessRow(row, client.columnOrderCache);
    }

    public async many(client: SmartClient): Promise<T["results"][]> {
        const { data, values } = this.serialize();
        const result = await client.query(data, values);
        return result.rows.map((row) => this.postProcessRow(row, client.columnOrderCache));
    }

    public stream<Options extends StreamOptions>(
        client: SmartClient,
        options?: Options,
    ): StreamShape<T["results"], Options> {
        const { data, values } = this.serialize();

        const stream = client.queryStream<T["results"], Options>(data, values, options, (row) =>
            this.postProcessRow(row as QueryResultRow, client.columnOrderCache),
        );

        return stream as StreamShape<T["results"], Options>;
    }

    private postProcessRow(row: QueryResultRow, columnOrderCache: ColumnOrderCache): T["results"] {
        const result = Object.create(null) as Record<string, any>;

        for (const [key, value] of Object.entries(row)) {
            const parser = this.parserMap[key];
            if (!parser) {
                result[key] = value;
                continue;
            }

            switch (parser.kind) {
                case "single": {
                    if (parser.spec === null) {
                        result[key] = value;
                    } else {
                        result[key] = parseTopLevel(parser.spec, value, columnOrderCache);
                    }
                    break;
                }
                case "mangled": {
                    const parentObject = (result[parser.parentObjectName] ??= Object.create(null));
                    result[parser.parentObjectName] = parentObject;

                    if (parser.spec === null) {
                        parentObject[parser.parentColumnName] = value;
                    } else {
                        parentObject[parser.parentColumnName] = parseTopLevel(parser.spec, value, columnOrderCache);
                    }
                    break;
                }
            }
        }

        return result;
    }

    private get parserMap() {
        if (this.#parserMap === null) {
            const parserMap = Object.create(null) as Record<string, ParserKind>;

            const needsParse = (
                parser: ParseSpec | null,
            ): parser is typeof parser & { kind: "composite" | "array" | "enum" } => {
                return parser !== null && typeof parser === "object";
            };

            const getParser = (e: Expression | Label): [string, ParserKind][] => {
                if (e instanceof Label) {
                    const parser = getParser(e.e);

                    if (parser.length < 1) {
                        return [];
                    }

                    if (parser.length > 1) {
                        console.error("Unable to get parser for labeled expression with multiple parsers");
                        return [];
                    }

                    return [[e.name, parser[0][1]]];
                }

                if (e instanceof TableExpression && needsParse(e.parser) && !this.experimentalMangle) {
                    return [[e.name, { kind: "single", spec: e.parser }]];
                }

                if (e instanceof TableExpression && needsParse(e.parser) && this.experimentalMangle) {
                    const results: [string, ParserKind][] = [];

                    for (const [colName, colParser] of e.parser.fields()) {
                        const spec = needsParse(colParser) ? colParser : null;

                        results.push([
                            `_${e.name}__${colName}`,
                            { kind: "mangled", spec, parentObjectName: e.name, parentColumnName: colName },
                        ]);
                    }

                    return results;
                }

                if (e instanceof ColumnExpression && needsParse(e.parser)) {
                    return [[e.columnName, { kind: "single", spec: e.parser }]];
                }

                if (e instanceof FunctionOperation && needsParse(e.parser)) {
                    return [[e.name, { kind: "single", spec: e.parser }]];
                }

                if (e instanceof ExecutableQuery) {
                    // A sub-query in a selection list yields a single column, so it takes the name
                    // and the parser of whatever the sub-query itself selects.
                    if (e.selections.length !== 1) {
                        return [];
                    }

                    return getParser(e.selections[0]);
                }

                return [];
            };

            for (const e of this.selections) {
                const parsers = getParser(e);
                for (const parser of parsers) {
                    parserMap[parser[0]] = parser[1];
                }
            }

            this.#parserMap = parserMap;
            return parserMap;
        }

        return this.#parserMap;
    }
}

export namespace QueryState {
    export type State = {
        selections: (Expression | Label)[];
        fromTable: TableBuilder | null;
        joins: ["inner" | "left", TableBuilder, Expression<boolean>][];
        whereClauses: Expression<boolean>[];
        orderClauses: [Expression, "asc" | "desc"][];
        groupByClauses: Expression[];
        limit: Expression<number> | null;
        offset: Expression<number> | null;
        forUpdate: boolean;
        skipLocked: boolean;
        tablesample: {
            kind: string;
            args: Expression[];
        } | null;
    };
}

export class QueryState<T extends ResultState> extends ExecutableQuery<T> {
    #state;
    protected selections: (Expression | Label)[] = [];

    constructor(private state: QueryState.State) {
        super();
        this.selections = state.selections;
        this.#state = state;
    }

    private with<TNew extends ResultState = T>(stateChange: Partial<QueryState.State>) {
        return new QueryState<TNew>({ ...this.#state, ...stateChange });
    }

    public from(fromTable: TableBuilder) {
        return this.with({ fromTable });
    }

    public innerJoin(fromTable: TableBuilder, condition: Expression<boolean>) {
        return this.with({ joins: [...this.#state.joins, ["inner", fromTable, condition]] });
    }

    public leftJoin(fromTable: TableBuilder, condition: Expression<boolean>) {
        return this.with({ joins: [...this.#state.joins, ["left", fromTable, condition]] });
    }

    public where(condition: Expression<boolean>) {
        return this.with({ whereClauses: [...this.#state.whereClauses, condition] });
    }

    public orderBy(condition: Expression, direction: "asc" | "desc" = "asc") {
        return this.with({ orderClauses: [...this.#state.orderClauses, [condition, direction]] });
    }

    public groupBy(condition: Expression) {
        return this.with({ groupByClauses: [...this.#state.groupByClauses, condition] });
    }

    public setLimit(limit: Expression<number>) {
        return this.with({ limit });
    }

    public setOffset(offset: Expression<number>) {
        return this.with({ offset });
    }

    public forUpdate() {
        return this.with({ forUpdate: true });
    }

    public skipLocked() {
        return this.with({ skipLocked: true });
    }

    public tableSample(kind: string, args: Expression[]) {
        return this.with({ tablesample: { kind, args } });
    }

    public serializeInto(state: MutableSerializationState, options: SerializeOptions) {
        if (this.#state.fromTable === null) {
            throw new Error("Unable to serialize query without a from-table");
        }

        let accumulator = "select " + this.buildSelectionList(state, options) + "\n";
        if (this.#state.fromTable.originalName === undefined) {
            accumulator += `from "${this.#state.fromTable.name}"\n`;
        } else {
            accumulator += `from "${this.#state.fromTable.originalName}" as "${this.#state.fromTable.name}"\n`;
        }

        for (const [kind, table, exp] of this.#state.joins) {
            if (table.originalName === undefined) {
                accumulator += `${kind} join "${table.name}" on ${serializeExpression(exp, state, options)}\n`;
            } else {
                accumulator += `${kind} join "${table.originalName}" as "${table.name}" on ${serializeExpression(exp, state, options)}\n`;
            }
        }

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state, options)).join(" and ")}\n`;
        }

        if (this.#state.orderClauses.length > 0) {
            accumulator += `order by ${this.#state.orderClauses.map(([e, dir]) => `${serializeExpression(e, state, options)} ${dir}`).join(", ")}\n`;
        }

        if (this.#state.groupByClauses.length > 0) {
            accumulator += `group by ${this.#state.groupByClauses.map((e) => serializeExpression(e, state, options)).join(", ")}\n`;
        }

        if (this.#state.limit !== null) {
            accumulator += `limit ${serializeExpression(this.#state.limit, state, options)}\n`;
        }

        if (this.#state.offset !== null) {
            accumulator += `offset ${serializeExpression(this.#state.offset, state, options)}\n`;
        }

        if (this.#state.forUpdate) {
            accumulator += "for update\n";
        }

        if (this.#state.skipLocked) {
            accumulator += "skip locked\n";
        }

        if (this.#state.tablesample) {
            accumulator += `tablesample ${this.#state.tablesample.kind} (${this.#state.tablesample.args.map((e) => serializeExpression(e, state, options)).join(", ")})\n`;
        }

        return accumulator;
    }
}

export namespace InsertState {
    export type State<ColumnState> = {
        table: TableBuilder<any, ColumnState, string>;
        values: Record<string, Expression>;
        conflictExpression:
            | { kind: "nothing"; keys?: ColumnExpression<unknown, string>[] }
            | { kind: "update"; keys: ColumnExpression<unknown, string>[]; updates: Record<string, Expression> }
            | null;
        returning: (Expression | Label)[] | null;
    };
}

export class InsertState<ColumnState, T extends ResultState = { results: {} }> extends ExecutableQuery<T> {
    #state: InsertState.State<ColumnState>;

    protected selections: (Expression | Label)[];

    constructor(state: InsertState.State<ColumnState>) {
        super();
        this.selections = state.returning ?? [];
        this.#state = state;
    }

    private with<TNew extends ResultState = T>(stateChange: Partial<InsertState.State<ColumnState>>) {
        return new InsertState<ColumnState, TNew>({ ...this.#state, ...stateChange });
    }

    public values(values: { [K in keyof ColumnState]?: Expression<ColumnState[K]> }) {
        return this.with({ values: values as Record<string, Expression> });
    }

    public onConflictDoNothing(keys?: ColumnExpression<unknown, string>[]) {
        return this.with({ conflictExpression: { kind: "nothing", keys } });
    }

    public onConflictDoUpdate(
        keys: ColumnExpression<unknown, string>[],
        updates: { [K in keyof ColumnState]?: Expression<ColumnState[K]> },
    ) {
        return this.with({
            conflictExpression: { kind: "update", keys, updates: updates as Record<string, Expression> },
        });
    }

    public returning<const T extends unknown[]>(
        ...args: T
    ): InsertState<ColumnState, { results: DecodeExpression<T> }> {
        return this.with({ returning: args as Expression[] });
    }

    public serializeInto(state: MutableSerializationState, options: SerializeOptions) {
        const keys = Object.keys(this.#state.values);
        const columns = keys.join(", ");
        const values = keys.map((e) => serializeExpression(this.#state.values[e], state, options)).join(", ");

        let accumulator = `insert into `;

        if (this.#state.table.originalName === undefined) {
            accumulator += `"${this.#state.table.name}"\n`;
        } else {
            accumulator += `"${this.#state.table.originalName}" as "${this.#state.table.name}"\n`;
        }

        accumulator += `(${columns}) values (${values})\n`;

        if (this.#state.conflictExpression !== null) {
            if (this.#state.conflictExpression.keys === undefined) {
                accumulator += "on conflict ";
            } else {
                accumulator += "on conflict (";
                accumulator += this.#state.conflictExpression.keys.map((e) => `"${e.columnName}"`).join(", ");
                accumulator += ") ";
            }

            if (this.#state.conflictExpression.kind === "nothing") {
                accumulator += "do nothing";
            } else {
                accumulator += "do update set ";
                accumulator += Object.entries(this.#state.conflictExpression.updates)
                    .map(([key, value]) => `"${key}" = ${serializeExpression(value, state, options)}`)
                    .join(", ");
            }

            accumulator += "\n";
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.buildSelectionList(state, options)}\n`;
        }

        return accumulator;
    }
}

export namespace UpdateState {
    export type State<ColumnState> = {
        table: TableBuilder<any, ColumnState, string>;
        updates: Record<string, Expression>;
        whereClauses: Expression<boolean>[];
        returning: Expression[] | null;
    };
}

export class UpdateState<ColumnState, T extends ResultState = { results: {} }> extends ExecutableQuery<T> {
    #state: UpdateState.State<ColumnState>;

    protected selections: (Expression | Label)[];

    constructor(state: UpdateState.State<ColumnState>) {
        super();
        this.selections = state.returning ?? [];
        this.#state = state;
    }

    private with<TNew extends ResultState = T>(stateChange: Partial<UpdateState.State<ColumnState>>) {
        return new UpdateState<ColumnState, TNew>({ ...this.#state, ...stateChange });
    }

    public set(updates: { [K in keyof ColumnState]?: Expression<ColumnState[K]> }) {
        return this.with({ updates: updates as Record<string, Expression> });
    }

    public where(condition: Expression<boolean>) {
        return this.with({ whereClauses: [...this.#state.whereClauses, condition] });
    }

    public whereEq(clauses: { [K in keyof ColumnState]?: Expression<ColumnState[K]> }) {
        const newClauses = Object.entries(clauses).map(([key, value]) =>
            Op.eq(this.#state.table.c[key as keyof ColumnState], value as Expression<any>),
        );

        return this.with({ whereClauses: [...this.#state.whereClauses, ...newClauses] });
    }

    public returning<const T extends unknown[]>(
        ...args: T
    ): UpdateState<ColumnState, { results: DecodeExpression<T> }> {
        return this.with({ returning: args as Expression[] });
    }

    public serializeInto(state: MutableSerializationState, options: SerializeOptions) {
        const updates = Object.entries(this.#state.updates)
            .map(([key, value]) => `"${key}" = ${serializeExpression(value, state, options)}`)
            .join(", ");
        let accumulator = `update `;

        if (this.#state.table.originalName === undefined) {
            accumulator += `"${this.#state.table.name}"\n`;
        } else {
            accumulator += `"${this.#state.table.originalName}" as "${this.#state.table.name}"\n`;
        }

        accumulator += `set ` + updates + "\n";

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state, options)).join(" and ")}\n`;
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.buildSelectionList(state, options)}\n`;
        }

        return accumulator;
    }
}

export namespace DeleteState {
    export type State = {
        table: TableBuilder;
        whereClauses: Expression<boolean>[];
        returning: Expression[] | null;
    };
}

export class DeleteState<T extends ResultState = { results: {} }> extends ExecutableQuery<T> {
    #state: DeleteState.State;

    protected selections: (Expression | Label)[];

    constructor(state: DeleteState.State) {
        super();
        this.#state = state;
        this.selections = state.returning ?? [];
    }

    private with<TNew extends ResultState = T>(stateChange: Partial<DeleteState.State>) {
        return new DeleteState<TNew>({ ...this.#state, ...stateChange });
    }

    public where(condition: Expression<boolean>) {
        return this.with({ whereClauses: [...this.#state.whereClauses, condition] });
    }

    public returning<const T extends unknown[]>(...args: T): DeleteState<{ results: DecodeExpression<T> }> {
        return this.with({ returning: args as Expression[] });
    }

    public serializeInto(state: MutableSerializationState, options: SerializeOptions) {
        let accumulator = `delete from `;

        if (this.#state.table.originalName === undefined) {
            accumulator += `"${this.#state.table.name}"\n`;
        } else {
            accumulator += `"${this.#state.table.originalName}" as "${this.#state.table.name}"\n`;
        }

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state, options)).join(" and ")}\n`;
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.buildSelectionList(state, options)}\n`;
        }

        return accumulator;
    }
}

export type DecodeExpression<T extends unknown[], Acc = {}> = T extends []
    ? Acc
    : T extends [Expression<infer Value, infer Name extends string>, ...infer Tail]
      ? DecodeExpression<Tail, Acc & { [K in Name]: Value }>
      : T extends [Label<infer Value, infer Name extends string>, ...infer Tail]
        ? DecodeExpression<Tail, Acc & { [K in Name]: Value }>
        : T extends [infer Literal, ...infer Tail]
          ? DecodeExpression<Tail, Acc & { [K in "?column?"]: Literal }>
          : never;

export const Select = <const T extends unknown[]>(...args: T): QueryState<{ results: DecodeExpression<T> }> => {
    return new QueryState({
        selections: args as (Expression | Label)[],
        fromTable: null,
        joins: [],
        whereClauses: [],
        orderClauses: [],
        groupByClauses: [],
        limit: null,
        offset: null,
        forUpdate: false,
        skipLocked: false,
        tablesample: null,
    });
};

export const Update = <const T>(table: TableBuilder<any, T, string>): UpdateState<T> => {
    return new UpdateState({ table, returning: null, updates: {}, whereClauses: [] });
};

export const Insert = <const T>(table: TableBuilder<any, T, string>): InsertState<T> => {
    return new InsertState({ table, values: {}, conflictExpression: null, returning: null });
};

export const Delete = <const T>(table: TableBuilder<any, T, string>): DeleteState => {
    return new DeleteState({ table, returning: null, whereClauses: [] });
};
