import {  } from "../../../src/types.js";

import { Query, EntityQueries } from "@piqued/client";


export const Query0: Query<Query0.InputArray, Query0.InputObject, Query0.TemplateInputObject, Query0.OutputArray, Query0.OutputObject> = {
    name: "query_0",
    query: `CREATE TABLE person ( id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, last_active_at TIMESTAMPTZ );`,
    params: [
    ],
    templateParams: [],
    spec: [
    ],
    _brand: undefined as any,
};

export namespace Query0 {
    export type InputArray = [
];
    export type InputObject = {
};
    export type TemplateInputObject = {};
    export type OutputArray = [
];
    export type OutputObject = {
};
}


export const Query1: Query<Query1.InputArray, Query1.InputObject, Query1.TemplateInputObject, Query1.OutputArray, Query1.OutputObject> = {
    name: "query_1",
    query: `CREATE TABLE session ( id SERIAL PRIMARY KEY, session_token TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id INTEGER NOT NULL REFERENCES person(id), last_active_at TIMESTAMPTZ );`,
    params: [
    ],
    templateParams: [],
    spec: [
    ],
    _brand: undefined as any,
};

export namespace Query1 {
    export type InputArray = [
];
    export type InputObject = {
};
    export type TemplateInputObject = {};
    export type OutputArray = [
];
    export type OutputObject = {
};
}


export default EntityQueries({
    "query0": Query0,
    "query1": Query1,
})

