import {  } from "../types";

import { Query, EntityQueries } from "@piqued/client";


export const Reflect: Query<Reflect.InputArray, Reflect.InputObject, Reflect.TemplateInputObject, Reflect.OutputArray, Reflect.OutputObject> = {
    name: "reflect",
    query: ` SELECT $1::text || ' from postgres!' AS input;`,
    params: [
        "$0",
    ],
    templateParams: [],
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
    export type TemplateInputObject = {};
    export type OutputArray = [
    input: string,
];
    export type OutputObject = {
    "input": string,
};
}


export const Reflect2: Query<Reflect2.InputArray, Reflect2.InputObject, Reflect2.TemplateInputObject, Reflect2.OutputArray, Reflect2.OutputObject> = {
    name: "reflect_2",
    query: `SELECT $1::text || ' from another postgres!', $2 AS input;`,
    params: [
        "first",
        "second",
    ],
    templateParams: [],
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
    export type TemplateInputObject = {};
    export type OutputArray = [
    column: string,
    input: string,
];
    export type OutputObject = {
    "?column?": string,
    "input": string,
};
}


export const Query2: Query<Query2.InputArray, Query2.InputObject, Query2.TemplateInputObject, Query2.OutputArray, Query2.OutputObject> = {
    name: "query_2",
    query: `SELECT 'This query has messy characters: \ \` ''';`,
    params: [
    ],
    templateParams: [],
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
    export type TemplateInputObject = {};
    export type OutputArray = [
    column: string,
];
    export type OutputObject = {
    "?column?": string,
};
}


export const Test: Query<Test.InputArray, Test.InputObject, Test.TemplateInputObject, Test.OutputArray, Test.OutputObject> = {
    name: "test",
    query: ` SELECT name FROM person WHERE uid IN :__tmpl_uids OR $1;`,
    params: [
        "force",
    ],
    templateParams: ["uids"],
    spec: [
        ["name", undefined],
    ],
    _brand: undefined as any,
};

export namespace Test {
    export type InputArray = [
    force: boolean,
];
    export type InputObject = {
    "force": boolean,
};
    export type TemplateInputObject = {"uids": any};
    export type OutputArray = [
    name: string,
];
    export type OutputObject = {
    "name": string,
};
}


export default EntityQueries({
    "reflect": Reflect,
    "reflect2": Reflect2,
    "query2": Query2,
    "test": Test,
})

