import { CustomParseSpec, ParseSpec } from "../types"
import { MutableSerializationState } from "./serialize";

export class ColumnExpression<Result, Name extends string> {
    constructor (public tableName: string, public columnName: Name, public parser: ParseSpec) {}
}

export class TableExpression<Result, Name extends string> {
    constructor (public name: Name, public parser: ParseSpec) {}
}

export class BinaryOperation<Result, Name extends string> {
    constructor(
        public operand: string,
        public left: Expression,
        public right: Expression,
    ) {}
}

export class UnaryOperation<Result, Name extends string> {
    constructor(
        public operand: string,
        public expression: Expression,
    ) {}
}

export class FunctionOperation<Result, Name extends string> {
    constructor(
        public name: Name,
        public args: Expression[],
        public parser: ParseSpec | null = null,
    ) {}
}

export class InterpolatedExpression<Result, Name extends string> {
    constructor(
        public name: Name,

        public parts: TemplateStringsArray,
        public expressions: Expression[],
    ) {
        if (parts.length !== expressions.length + 1) {
            throw new Error("Invalid interpolation");
        }
    }
}

export type StructuredExpression<T, Name extends string> =
    | ColumnExpression<T, Name>
    | TableExpression<T, Name>
    | BinaryOperation<T, Name>
    | UnaryOperation<T, Name>
    | FunctionOperation<T, Name>
    | InterpolatedExpression<T, Name>
    ;

export type LiteralExpression =
    | string
    | number
    | boolean
    | null
    | undefined
    | Date
    | LiteralExpression[]
    ;

export type Expression<T = unknown, Name extends string = string> =
    StructuredExpression<T, Name> | LiteralExpression;

export namespace Op {
    const recursivelyFindSpec = (...es: Expression[]): ParseSpec | null => {
        for (const e of es) {
            if (e instanceof ColumnExpression) {
                return e.parser;
            }

            if (e instanceof TableExpression) {
                return e.parser;
            }

            if (e instanceof FunctionOperation) {
                return e.parser;
            }
        }

        return null
    };

    export function not(e: Expression) {
        return new UnaryOperation<boolean, "not">("not", e);
    }

    export function lt(left: Expression, right: Expression) {
        return new BinaryOperation<boolean, "?column?">("<", left, right);
    }

    export function eq(left: Expression, right: Expression) {
        return new BinaryOperation<boolean, "?column?">("=", left, right);
    }

    export function coalesce<T>(...args: Expression<T>[]) {
        return new FunctionOperation<T, "coalesce">("coalesce", args);
    }

    export function arrayAgg<V>(e: Expression<V>) {
        const baseSpec = recursivelyFindSpec(e);
        const spec: ParseSpec | null = baseSpec ? { kind: "array", spec: baseSpec } : null;

        return new FunctionOperation<V[], "array_agg">("array_agg", [e], spec);
    }

    export const exp = <T>(strings: TemplateStringsArray, ...expressions: Expression[]) => {
        return new InterpolatedExpression<T, "?column?">("?column?", strings, expressions);
    }
}


type Despecify<Spec extends readonly any[], Result, Acc extends ColumnExpression<unknown, string>[] = []> =
    Spec extends [] ? Acc :
    Spec extends readonly [readonly [infer Name extends string, any], ...(infer Tail extends any[])] ?
        Name extends keyof Result ?
            Despecify<Tail, Result, [...Acc, ColumnExpression<Result[Name], Name>]> :
        never :
    never;

export class TableBuilder<
        Spec extends CustomParseSpec & { kind: "composite" } = any,
        Result = unknown,
        const Name extends string = string,
> {
    public name;
    public c: { [K in keyof Result]: K extends string ? ColumnExpression<Result[K], K> : never }
    public parser;

    private parseSpecByName;

    public constructor (
        name: Name,
        parser: Spec,
    ) {
        this.name = name;
        this.parser = parser;
        this.parseSpecByName = {} as { [K in keyof Result]: ParseSpec };

        for (const [key, value] of parser.fields()) {
            this.parseSpecByName[key as keyof Result] ??= value; // If there are dupes we take the first
        }

        this.c = new Proxy({} as any, {
            get: (_target, key: string) => {
                if (!this.parseSpecByName) {
                    throw new Error(`Invalid column of table ${this.name}: ${key}`);
                }

                return new ColumnExpression(this.name, key, this.parseSpecByName[key as keyof Result])
            }
        })
    }

    public get table() {
        return new TableExpression<Result, Name>(this.name, this.parser);
    }

    public get star() {
        const results: Expression[] = [];
        for (const [name, spec] of this.parser.fields()) {
            results.push(new ColumnExpression(this.name, name, spec));
        }

        return results as Despecify<ReturnType<Spec["fields"]>, Result>;
    }
}

export class Label<T = unknown, Name extends string = string> {
    constructor (public e: Expression<T, string>, public name: Name) {}
}

export const label = <T = unknown, Name extends string = string>(e: Expression<T, string>, name: Name) => {
    return new Label(e, name);
}

const addAndReturnParam = (state: MutableSerializationState, value: any) => {
    state.paramValues.push(value);
    state.paramCount += 1;
    return `$${state.paramCount}`;
}

export const serializeExpression = (e: Expression | Label, state: MutableSerializationState): string => {
    if (
        typeof e === "string"
        || typeof e === "number"
        || typeof e === "boolean"
        || typeof e === "undefined"
        || e === null
        || Array.isArray(e)
        || e instanceof Date
    ) {
        return addAndReturnParam(state, e);
    }

    if (e instanceof TableExpression) {
        return `"${e.name}"`;
    }

    if (e instanceof ColumnExpression) {
        return `"${e.tableName}"."${e.columnName}"`;
    }

    if (e instanceof UnaryOperation) {
        return `(${e.operand} ${serializeExpression(e.expression, state)})`;
    }

    if (e instanceof BinaryOperation) {
        return `(${serializeExpression(e.left, state)} ${e.operand} ${serializeExpression(e.right, state)})`;
    }

    if (e instanceof FunctionOperation) {
        return `${e.name}(${e.args.map((e) => serializeExpression(e, state)).join(", ")})`;
    }

    if (e instanceof InterpolatedExpression) {
        return e.expressions.map((exp, i) => `${e.parts[i]}${serializeExpression(exp, state)}`).join("") + e.parts[e.parts.length - 1];
    }

    if (e instanceof Label) {
        return `${serializeExpression(e.e, state)} as ${e.name}`;
    }

    throw new Error("Unexpected expression", e);
}
