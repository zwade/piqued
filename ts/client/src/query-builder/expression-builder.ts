import { CustomParseSpec, ParseSpec } from "../types";
import { MutableSerializationState } from "./serialize";

export class ColumnExpression<_Result, Name extends string> {
    constructor(
        public tableName: string,
        public columnName: Name,
        public parser: ParseSpec,
    ) {}
}

export class TableExpression<_Result, Name extends string> {
    constructor(
        public name: Name,
        public parser: ParseSpec,
    ) {}
}

export class BinaryOperation<_Result, _Name extends string> {
    constructor(
        public operand: string,
        public left: Expression,
        public right: Expression,
    ) {}
}

export class UnaryOperation<_Result, _Name extends string> {
    constructor(
        public operand: string,
        public expression: Expression,
    ) {}
}

export class FunctionOperation<_Result, Name extends string> {
    constructor(
        public name: Name,
        public args: Expression[],
        public parser: ParseSpec | null = null,
    ) {}
}

export class InterpolatedExpression<_Result, Name extends string> {
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

export class TupleExpression<_T, _Name extends string> {
    constructor(public expressions: LiteralExpression[]) {}
}

export const tuple = (expressions: LiteralExpression[]) => {
    return new TupleExpression(expressions);
};

export class RawExpression<_T, _Name extends string> {
    constructor(public expression: string) {}
}

export const raw = (expression: string) => {
    return new RawExpression(expression);
};

export type StructuredExpression<T, Name extends string> =
    | ColumnExpression<T, Name>
    | TableExpression<T, Name>
    | BinaryOperation<T, Name>
    | UnaryOperation<T, Name>
    | FunctionOperation<T, Name>
    | TupleExpression<T, Name>
    | InterpolatedExpression<T, Name>
    | RawExpression<T, Name>;

export type LiteralExpression =
    | string
    | number
    | boolean
    | null
    | undefined
    | Date
    | Buffer
    | { [key: string]: LiteralExpression }
    | LiteralExpression[];

export type Expression<T = unknown, Name extends string = string> = StructuredExpression<T, Name> | LiteralExpression;

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

        return null;
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

    export function in_(left: Expression, right: Expression) {
        if (Array.isArray(right)) {
            right = tuple(right);
        }

        return new BinaryOperation<boolean, "?column?">("IN", left, right);
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
    };

    export const and = <T>(...expressions: Expression<T>[]) => {
        return new FunctionOperation<boolean, "and">("and", expressions);
    };

    export const or = <T>(...expressions: Expression<T>[]) => {
        return new FunctionOperation<boolean, "or">("or", expressions);
    };
}

type Despecify<
    Spec extends readonly any[],
    Result,
    Acc extends ColumnExpression<unknown, string>[] = [],
> = Spec extends []
    ? Acc
    : Spec extends readonly [readonly [infer Name extends string, any], ...infer Tail extends any[]]
      ? Name extends keyof Result
          ? Despecify<Tail, Result, [...Acc, ColumnExpression<Result[Name], Name>]>
          : never
      : never;

export class TableBuilder<
    Spec extends CustomParseSpec & { kind: "composite" } = any,
    Result = unknown,
    const Name extends string = string,
> {
    public name;
    public c: { [K in keyof Result]: K extends string ? ColumnExpression<Result[K], K> : never };
    public parser;

    private parseSpecByName;

    public constructor(name: Name, parser: Spec) {
        this.name = name;
        this.parser = parser;
        this.parseSpecByName = Object.create(null) as { [K in keyof Result]: ParseSpec };

        for (const [key, value] of parser.fields()) {
            this.parseSpecByName[key as keyof Result] ??= value; // If there are dupes we take the first
        }

        this.c = new Proxy({} as any, {
            get: (_target, key: string) => {
                if (!this.parseSpecByName) {
                    throw new Error(`Invalid column of table ${this.name}: ${key}`);
                }

                return new ColumnExpression(this.name, key, this.parseSpecByName[key as keyof Result]);
            },
        });
    }

    public match(args: { [K in keyof Result]: K extends string ? Expression<Result[K], K> : never }) {
        const entries = Object.entries(args);
        if (entries.length === 0) {
            return true;
        }

        const booleanExpressions = entries.map(([key, value]) => {
            return Op.eq(this.c[key as keyof Result], value as Expression);
        });

        return booleanExpressions.reduce((acc, e) => Op.and(acc, e), true as Expression<boolean>);
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
    constructor(
        public e: Expression<T, string>,
        public name: Name,
    ) {}
}

export const label = <T = unknown, Name extends string = string>(e: Expression<T, string>, name: Name) => {
    return new Label(e, name);
};

const addAndReturnParam = (state: MutableSerializationState, value: any) => {
    state.paramValues.push(value);
    state.paramCount += 1;
    return `$${state.paramCount}`;
};

export interface SerializeOptions {
    inlineOnly?: boolean;
}

export const serializeExpression = (
    e: Expression | Label,
    state: MutableSerializationState,
    options: SerializeOptions = {},
): string => {
    if (
        typeof e === "string" ||
        typeof e === "number" ||
        typeof e === "boolean" ||
        typeof e === "undefined" ||
        e instanceof Buffer ||
        e === null ||
        Array.isArray(e) ||
        e instanceof Date
    ) {
        if (options.inlineOnly) {
            return serializeInlineExpression(e);
        } else {
            return addAndReturnParam(state, e);
        }
    }

    if (e instanceof TableExpression) {
        return `"${e.name}"`;
    }

    if (e instanceof ColumnExpression) {
        return `"${e.tableName}"."${e.columnName}"`;
    }

    if (e instanceof UnaryOperation) {
        return `(${e.operand} ${serializeExpression(e.expression, state, options)})`;
    }

    if (e instanceof BinaryOperation) {
        return `(${serializeExpression(e.left, state, options)} ${e.operand} ${serializeExpression(e.right, state, options)})`;
    }

    if (e instanceof FunctionOperation) {
        return `${e.name}(${e.args.map((e) => serializeExpression(e, state, options)).join(", ")})`;
    }

    if (e instanceof InterpolatedExpression) {
        return (
            e.expressions.map((exp, i) => `${e.parts[i]}${serializeExpression(exp, state, options)}`).join("") +
            e.parts[e.parts.length - 1]
        );
    }

    if (e instanceof TupleExpression) {
        return `(${e.expressions.map((e) => serializeExpression(e, state, { ...options, inlineOnly: true })).join(",")})`;
    }

    if (e instanceof RawExpression) {
        return e.expression;
    }

    if (e instanceof Label) {
        return `${serializeExpression(e.e, state)} as ${e.name}`;
    }

    return addAndReturnParam(state, e);
};

/**
 * Serializes a postgres expression for use in a tuple
 */
export const serializeInlineExpression = (e: LiteralExpression): string => {
    switch (typeof e) {
        case "string": {
            return `'${e.replace(/"/g, '\\"')}'`; // Only support non-extended strings
        }
        case "number": {
            if (isNaN(e)) {
                return "NaN";
            }

            if (!isFinite(e)) {
                return e > 0 ? "Infinity" : "-Infinity";
            }

            return e.toString();
        }
        case "boolean": {
            return e ? "TRUE" : "FALSE";
        }
        case "undefined": {
            return "NULL";
        }
        default: {
            if (e === null) {
                return "NULL";
            }

            if (e instanceof Buffer) {
                return `"\\\\x${e.toString("hex")}"`;
            }

            if (e instanceof Date) {
                return `"${e.toISOString()}"`;
            }

            if (e instanceof Array) {
                return `{${e.map(serializeInlineExpression).join(",")}}`;
            }

            if (e instanceof TupleExpression) {
                return `(${e.expressions.map(serializeInlineExpression).join(",")})`;
            }

            throw new Error("Unable to serialize expression", e);
        }
    }
};
