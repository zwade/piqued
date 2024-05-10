import { Company } from "../types";

import { Query, EntityQueries } from "@piqued/client";


export const Reflect: Query<Reflect.InputArray, Reflect.InputObject, Reflect.OutputArray, Reflect.OutputObject> = {
    name: "reflect",
    query: `SELECT $1::text || ' from postgres!' AS input`,
    params: [
        "$0",
    ],
    spec: [
        ["input", undefined],
    ],
    _brand: undefined as any,
};

export namespace Reflect {
    export type InputArray = [
        $0: string,
    ];
    export type InputObject = {
        "$0": string,
    };
    export type OutputArray = [
        input: string,
    ];
    export type OutputObject = {
        "input": string,
    };
}

export const Reflect2: Query<Reflect2.InputArray, Reflect2.InputObject, Reflect2.OutputArray, Reflect2.OutputObject> = {
    name: "reflect_2",
    query: `SELECT $1::text || ' from another postgres!', $2 AS input`,
    params: [
        "first",
        "second",
    ],
    spec: [
        ["?column?", undefined],
        ["input", undefined],
    ],
    _brand: undefined as any,
};

export namespace Reflect2 {
    export type InputArray = [
        first: string,
        second: string,
    ];
    export type InputObject = {
        "first": string,
        "second": string,
    };
    export type OutputArray = [
        column: string,
        input: string,
    ];
    export type OutputObject = {
        "?column?": string,
        "input": string,
    };
}

export const Query2: Query<Query2.InputArray, Query2.InputObject, Query2.OutputArray, Query2.OutputObject> = {
    name: "query_2",
    query: `SELECT E'This query has messy characters: \\ \` '''`,
    params: [
    ],
    spec: [
        ["?column?", undefined],
    ],
    _brand: undefined as any,
};

export namespace Query2 {
    export type InputArray = [
    ];
    export type InputObject = {
    };
    export type OutputArray = [
        column: string,
    ];
    export type OutputObject = {
        "?column?": string,
    };
}

export const Query3: Query<Query3.InputArray, Query3.InputObject, Query3.OutputArray, Query3.OutputObject> = {
    name: "query_3",
    query: `SELECT company, 1 FROM company`,
    params: [
    ],
    spec: [
        ["company", Company.spec],
        ["?column?", undefined],
    ],
    _brand: undefined as any,
};

export namespace Query3 {
    export type InputArray = [
    ];
    export type InputObject = {
    };
    export type OutputArray = [
        company: Company.t,
        column: number,
    ];
    export type OutputObject = {
        "company": Company.t,
        "?column?": number,
    };
}

export default EntityQueries({
    "reflect": Reflect,
    "reflect2": Reflect2,
    "query2": Query2,
    "query3": Query3,
})

