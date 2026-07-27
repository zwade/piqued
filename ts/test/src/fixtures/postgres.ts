// This file mimics the output that `piqued` emits for its `emit.typeFile`.
// It is hand-written and hard-coded so that the test suite never needs a live database.
// Keep it byte-for-byte in the shape the generator produces — if the generator's output
// format changes, this file should change with it.

export namespace PiquedHead {
    export const name = "_piqued_head";

    export type t = {
        index_key: number;
        head: string | null;
    };

    export const spec = {
        kind: "composite" as const,
        fields: () =>
            [
                ["index_key", Number],
                ["head", String],
            ] as const,
    };
}

export namespace Person {
    export const name = "person";

    export type t = {
        id: number;
        created_at: Date;
        name: string | null;
        email: string;
        last_active_at: Date | null;
        first_name: string | null;
        last_name: string | null;
    };

    export const spec = {
        kind: "composite" as const,
        fields: () =>
            [
                ["id", Number],
                ["created_at", Date],
                ["name", String],
                ["email", String],
                ["last_active_at", Date],
                ["first_name", String],
                ["last_name", String],
            ] as const,
    };
}

export namespace Session {
    export const name = "session";

    export type t = {
        id: number;
        session_token: string;
        created_at: Date;
        user_id: number;
        last_active_at: Date | null;
    };

    export const spec = {
        kind: "composite" as const,
        fields: () =>
            [
                ["id", Number],
                ["session_token", String],
                ["created_at", Date],
                ["user_id", Number],
                ["last_active_at", Date],
            ] as const,
    };
}

export namespace Organization {
    export const name = "organization";

    export type t = {
        id: number;
        name: string;
        owner_id: number;
        created_at: Date;
    };

    export const spec = {
        kind: "composite" as const,
        fields: () =>
            [
                ["id", Number],
                ["name", String],
                ["owner_id", Number],
                ["created_at", Date],
            ] as const,
    };
}
