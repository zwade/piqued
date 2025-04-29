import { QueryResultRow } from "pg";

import { parse } from "../parser";
import { SmartClient } from "../smart-client";
import { ParseSpec } from "../types";
import {
    ColumnExpression,
    Expression,
    FunctionOperation,
    Label,
    Op,
    serializeExpression,
    TableBuilder,
    TableExpression,
} from "./expression-builder";
import { MutableSerializationState } from "./serialize";

export type ResultState = {
    results: Record<string, unknown>;
};

export abstract class ExecutableQuery<T extends ResultState> {
    #parserMap: Record<string, ParseSpec | null> | null = null;

    protected abstract selections: (Expression | Label)[];

    public abstract serialize(): { data: string; values: any[] };

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

        return this.postProcessRow(row);
    }

    public async opt(client: SmartClient): Promise<T["results"] | undefined> {
        const { data, values } = this.serialize();
        const result = await client.query(data, values);

        const row = result.rows[0];
        if (!row) {
            return undefined;
        }

        return this.postProcessRow(row);
    }

    public async many(client: SmartClient): Promise<T["results"][]> {
        const { data, values } = this.serialize();
        const result = await client.query(data, values);
        return result.rows.map((row) => this.postProcessRow(row));
    }

    private postProcessRow(row: QueryResultRow): T["results"] {
        const result = {} as Record<string, any>;

        for (const [key, value] of Object.entries(row)) {
            const parser = this.parserMap[key];
            if (parser) {
                result[key] = parse(parser, value);
            } else {
                result[key] = value;
            }
        }

        return result;
    }

    private get parserMap() {
        if (this.#parserMap === null) {
            const parserMap = Object.create(null) as Record<string, ParseSpec | null>;

            const needsParse = (
                parser: ParseSpec | null,
            ): parser is typeof parser & { kind: "composite" | "array" | "enum" } => {
                return parser !== null && typeof parser === "object";
            };

            const getParser = (e: Expression | Label): [string, ParseSpec] | null => {
                if (e instanceof Label) {
                    const parser = getParser(e.e);

                    if (parser === null) {
                        return null;
                    }

                    return [e.name, parser[1]];
                }

                if (e instanceof TableExpression && needsParse(e.parser)) {
                    return [e.name, e.parser];
                }

                if (e instanceof ColumnExpression && needsParse(e.parser)) {
                    return [e.tableName, e.parser];
                }

                if (e instanceof FunctionOperation && needsParse(e.parser)) {
                    return [e.name, e.parser];
                }

                return null;
            };

            for (const e of this.selections) {
                const parser = getParser(e);
                if (parser) {
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

    public serialize() {
        if (this.#state.fromTable === null) {
            throw new Error("Unable to serialize query without a from-table");
        }

        const state: MutableSerializationState = {
            paramCount: 0,
            paramValues: [],
        };

        let accumulator =
            "select " + this.#state.selections.map((e) => serializeExpression(e, state)).join(", ") + "\n";
        accumulator += `from "${this.#state.fromTable.name}"\n`;

        for (const [kind, table, exp] of this.#state.joins) {
            accumulator += `${kind} join "${table.name}" on ${serializeExpression(exp, state)}\n`;
        }

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state)).join(" and ")}\n`;
        }

        if (this.#state.orderClauses.length > 0) {
            accumulator += `order by ${this.#state.orderClauses.map(([e, dir]) => `${serializeExpression(e, state)} ${dir}`).join(", ")}\n`;
        }

        if (this.#state.limit !== null) {
            accumulator += `limit ${serializeExpression(this.#state.limit, state)}\n`;
        }

        if (this.#state.offset !== null) {
            accumulator += `offset ${serializeExpression(this.#state.offset, state)}\n`;
        }

        if (this.#state.forUpdate) {
            accumulator += "for update\n";
        }

        if (this.#state.skipLocked) {
            accumulator += "skip locked\n";
        }

        if (this.#state.tablesample) {
            accumulator += `tablesample ${this.#state.tablesample.kind} (${this.#state.tablesample.args.map((e) => serializeExpression(e, state)).join(", ")})\n`;
        }

        return {
            data: accumulator + ";",
            values: state.paramValues,
        };
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

    public serialize() {
        const state: MutableSerializationState = {
            paramCount: 0,
            paramValues: [],
        };

        const keys = Object.keys(this.#state.values);
        const columns = keys.join(", ");
        const values = keys.map((e) => serializeExpression(this.#state.values[e], state)).join(", ");

        let accumulator = `insert into "${this.#state.table.name}" (${columns}) values (${values})\n`;

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
                    .map(([key, value]) => `"${key}" = ${serializeExpression(value, state)}`)
                    .join(", ");
            }

            accumulator += "\n";
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.#state.returning.map((e) => serializeExpression(e, state)).join(", ")}`;
        }

        return {
            data: accumulator + ";",
            values: state.paramValues,
        };
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

    public serialize() {
        const state: MutableSerializationState = {
            paramCount: 0,
            paramValues: [],
        };

        const updates = Object.entries(this.#state.updates)
            .map(([key, value]) => `"${key}" = ${serializeExpression(value, state)}`)
            .join(", ");
        let accumulator = `update "${this.#state.table.name}" set ` + updates + "\n";

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state)).join(" and ")}`;
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.#state.returning.map((e) => serializeExpression(e, state)).join(", ")}`;
        }

        return {
            data: accumulator + ";",
            values: state.paramValues,
        };
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

    public serialize() {
        const state: MutableSerializationState = {
            paramCount: 0,
            paramValues: [],
        };

        let accumulator = `delete from "${this.#state.table.name}"\n`;

        if (this.#state.whereClauses.length > 0) {
            accumulator += `where ${this.#state.whereClauses.map((e) => serializeExpression(e, state)).join(" and ")}`;
        }

        if (this.#state.returning !== null) {
            accumulator += `returning ${this.#state.returning.map((e) => serializeExpression(e, state)).join(", ")}`;
        }

        return {
            data: accumulator + ";",
            values: state.paramValues,
        };
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
