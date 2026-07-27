export interface MutableSerializationState {
    paramCount: number;
    paramValues: any[];
}

export interface SerializeOptions {
    inlineOnly?: boolean;
    tableNameMap?: Record<string, string>;
}

/**
 * Base class for anything that can be embedded inside an expression as a parenthesized sub-query
 * (e.g. `set({ count: Select(Op.count()).from(other) })`).
 *
 * It lives here, rather than alongside the queries themselves, so that `serializeExpression` can
 * recognize sub-queries without importing the query builder (which would be a cycle).
 */
export abstract class SubQuery<_Value = unknown, _Name extends string = string> {
    /**
     * Serializes the query into an existing serialization state so that parameter numbering is
     * shared with the enclosing statement. The result must not be terminated with a semicolon.
     */
    public abstract serializeInto(state: MutableSerializationState, options: SerializeOptions): string;
}

/** The single value produced by a sub-query's result row, used when it appears in an expression. */
export type ScalarValueOf<Results> = keyof Results extends never ? unknown : Results[keyof Results];

/** The column name produced by a sub-query's result row, used when it appears in an expression. */
export type ScalarNameOf<Results> = keyof Results extends string ? keyof Results : string;
